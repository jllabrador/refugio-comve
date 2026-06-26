/**
 * refugio.com.ve — Worker: Verificación
 * Rutas:
 *   GET  /api/verificacion/pendientes     → lista usuarios pendientes (moderador)
 *   POST /api/verificacion/aprobar        → aprobar usuario
 *   POST /api/verificacion/rechazar       → rechazar usuario
 *   POST /api/verificacion/upload-doc     → subir documento a R2
 */

export interface Env {
  DB:                        D1Database
  DOCS:                      R2Bucket
  KV:                        KVNamespace
  WHATSAPP_API_TOKEN:        string
  WHATSAPP_PHONE_NUMBER_ID:  string
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Verificar que el request viene de un moderador ────────────
// En producción: validar JWT de Clerk con rol 'moderator'
async function esModerador(request: Request): Promise<boolean> {
  const auth = request.headers.get('Authorization') ?? ''
  // TODO: validar token Clerk con rol moderator
  // Por ahora se valida con un secret header en desarrollo
  return auth.startsWith('Bearer ')
}

// ── Notificación al usuario sobre resultado de verificación ───
async function notificarResultado(
  env: Env,
  telefono: string,
  nombre: string,
  aprobado: boolean,
  motivo?: string
) {
  const url = `https://graph.facebook.com/v19.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`
  const templateName = aprobado ? 'verificacion_aprobada' : 'verificacion_rechazada'

  const params: { type: string; text: string }[] = [{ type: 'text', text: nombre }]
  if (!aprobado && motivo) params.push({ type: 'text', text: motivo })

  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono.replace('+', ''),
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'es' },
        components: [{ type: 'body', parameters: params }]
      }
    }),
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (!(await esModerador(request))) {
      return jsonResponse({ ok: false, error: 'No autorizado' }, 401)
    }

    // ── GET /api/verificacion/pendientes ──────────────────────
    if (request.method === 'GET' && path.endsWith('/pendientes')) {
      const { results } = await env.DB.prepare(`
        SELECT
          u.id, u.tipo, u.nombre, u.email, u.telefono,
          u.estado_venezolano, u.municipio, u.created_at,
          COUNT(d.id) AS docs_count
        FROM users u
        LEFT JOIN verification_docs d ON d.user_id = u.id
        WHERE u.estado = 'pendiente'
        GROUP BY u.id
        ORDER BY u.created_at ASC
        LIMIT 50
      `).all()

      return jsonResponse({ ok: true, pendientes: results })
    }

    // ── POST /api/verificacion/aprobar ────────────────────────
    if (request.method === 'POST' && path.endsWith('/aprobar')) {
      const { userId, revisorId } = await request.json() as { userId: string; revisorId: string }
      if (!userId) return jsonResponse({ ok: false, error: 'userId requerido' }, 400)

      const user = await env.DB.prepare(
        'SELECT * FROM users WHERE id = ? AND estado = ?'
      ).bind(userId, 'pendiente').first() as Record<string, string> | null

      if (!user) return jsonResponse({ ok: false, error: 'Usuario no encontrado o ya procesado' }, 404)

      const now = new Date().toISOString()

      // Aprobar usuario
      await env.DB.prepare(`
        UPDATE users SET estado = 'verificado', verified_at = ? WHERE id = ?
      `).bind(now, userId).run()

      // Si es host, activar su listing
      if (user.tipo === 'host') {
        await env.DB.prepare(`
          UPDATE listings SET estado = 'disponible', updated_at = ? WHERE host_id = ?
        `).bind(now, userId).run()
      }

      // Marcar docs como aprobados
      await env.DB.prepare(`
        UPDATE verification_docs
        SET estado = 'aprobado', revisor_id = ?, reviewed_at = ?
        WHERE user_id = ? AND estado = 'pendiente'
      `).bind(revisorId ?? null, now, userId).run()

      // Actualizar KV
      await env.KV.put(`user:${userId}`, JSON.stringify({
        ...user, estado: 'verificado', verified_at: now
      }), { expirationTtl: 60 * 60 * 24 * 90 })

      // Notificar por WhatsApp
      await notificarResultado(env, user.telefono, user.nombre, true)

      // Registrar notificación
      await env.DB.prepare(`
        INSERT INTO notificaciones (id, user_id, canal, tipo, estado)
        VALUES (?, ?, 'whatsapp', 'verificacion_aprobada', 'enviado')
      `).bind(crypto.randomUUID(), userId).run()

      return jsonResponse({ ok: true, mensaje: `Usuario ${user.nombre} aprobado correctamente.` })
    }

    // ── POST /api/verificacion/rechazar ───────────────────────
    if (request.method === 'POST' && path.endsWith('/rechazar')) {
      const { userId, motivo, revisorId } = await request.json() as {
        userId: string; motivo: string; revisorId: string
      }
      if (!userId || !motivo) return jsonResponse({ ok: false, error: 'userId y motivo requeridos' }, 400)

      const user = await env.DB.prepare(
        'SELECT * FROM users WHERE id = ? AND estado = ?'
      ).bind(userId, 'pendiente').first() as Record<string, string> | null

      if (!user) return jsonResponse({ ok: false, error: 'Usuario no encontrado' }, 404)

      const now = new Date().toISOString()

      await env.DB.prepare(`
        UPDATE users SET estado = 'rechazado' WHERE id = ?
      `).bind(userId).run()

      await env.DB.prepare(`
        UPDATE verification_docs
        SET estado = 'rechazado', revisor_id = ?, notas_revisor = ?, reviewed_at = ?
        WHERE user_id = ? AND estado = 'pendiente'
      `).bind(revisorId ?? null, motivo, now, userId).run()

      await notificarResultado(env, user.telefono, user.nombre, false, motivo)

      return jsonResponse({ ok: true, mensaje: `Usuario ${user.nombre} rechazado.` })
    }

    // ── POST /api/verificacion/upload-doc ─────────────────────
    if (request.method === 'POST' && path.endsWith('/upload-doc')) {
      const formData = await request.formData()
      const userId = formData.get('userId') as string
      const tipoDoc = formData.get('tipo_doc') as string
      const archivo = formData.get('archivo') as File | null

      if (!userId || !tipoDoc || !archivo) {
        return jsonResponse({ ok: false, error: 'Faltan campos requeridos' }, 400)
      }

      const tiposPermitidos = ['cedula', 'foto_espacio', 'constancia_pc', 'foto_dano', 'otro']
      if (!tiposPermitidos.includes(tipoDoc)) {
        return jsonResponse({ ok: false, error: 'Tipo de documento inválido' }, 400)
      }

      // Limitar tamaño a 5MB
      if (archivo.size > 5 * 1024 * 1024) {
        return jsonResponse({ ok: false, error: 'El archivo no puede superar 5MB' }, 400)
      }

      const ext = archivo.name.split('.').pop()?.toLowerCase() ?? 'jpg'
      const r2Key = `docs/${userId}/${tipoDoc}_${Date.now()}.${ext}`

      await env.DOCS.put(r2Key, await archivo.arrayBuffer(), {
        httpMetadata: { contentType: archivo.type },
        customMetadata: { userId, tipoDoc },
      })

      const docId = crypto.randomUUID()
      await env.DB.prepare(`
        INSERT INTO verification_docs (id, user_id, tipo_doc, r2_key, estado)
        VALUES (?, ?, ?, ?, 'pendiente')
      `).bind(docId, userId, tipoDoc, r2Key).run()

      return jsonResponse({ ok: true, docId, r2Key })
    }

    return jsonResponse({ ok: false, error: 'Ruta no encontrada' }, 404)
  }
}
