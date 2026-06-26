/**
 * refugio.com.ve — Worker: Match
 * Rutas:
 *   GET  /api/match/listings         → listings disponibles filtrados por estado
 *   POST /api/match/solicitar        → refugee solicita un listing
 *   POST /api/match/responder        → host acepta o rechaza solicitud
 *   POST /api/match/renovar          → refugee solicita renovación de 30 días
 *   POST /api/match/cancelar         → cualquiera cancela el match activo
 */

export interface Env {
  DB:                        D1Database
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

function addDays(date: Date, days: number): string {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result.toISOString()
}

async function enviarWhatsApp(env: Env, telefono: string, template: string, params: string[]) {
  await fetch(`https://graph.facebook.com/v19.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
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
        name: template,
        language: { code: 'es' },
        components: [{
          type: 'body',
          parameters: params.map(text => ({ type: 'text', text }))
        }]
      }
    }),
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // ── GET /api/match/listings ───────────────────────────────
    if (request.method === 'GET' && path.endsWith('/listings')) {
      const estadoVe = url.searchParams.get('estado') ?? ''
      const ninos    = url.searchParams.get('ninos') === '1'
      const mascotas = url.searchParams.get('mascotas') === '1'

      let query = `
        SELECT
          l.id, l.tipo_espacio, l.capacidad, l.municipio,
          l.estado_venezolano, l.tiene_agua, l.tiene_luz,
          l.tiene_gas, l.tiene_wifi, l.acepta_ninos, l.acepta_mascotas,
          u.nombre AS host_nombre
        FROM listings l
        JOIN users u ON u.id = l.host_id
        WHERE l.estado = 'disponible' AND u.estado = 'verificado'
      `
      const bindings: (string | number)[] = []

      if (estadoVe) { query += ' AND l.estado_venezolano = ?'; bindings.push(estadoVe) }
      if (ninos)    { query += ' AND l.acepta_ninos = 1' }
      if (mascotas) { query += ' AND l.acepta_mascotas = 1' }
      query += ' ORDER BY l.created_at DESC LIMIT 30'

      const { results } = await env.DB.prepare(query).bind(...bindings).all()
      return jsonResponse({ ok: true, listings: results })
    }

    // ── POST /api/match/solicitar ─────────────────────────────
    if (request.method === 'POST' && path.endsWith('/solicitar')) {
      const { listingId, refugeeId } = await request.json() as {
        listingId: string; refugeeId: string
      }

      // Verificar que el refugee está verificado
      const refugee = await env.DB.prepare(
        "SELECT * FROM users WHERE id = ? AND tipo = 'refugee' AND estado = 'verificado'"
      ).bind(refugeeId).first() as Record<string, string> | null
      if (!refugee) return jsonResponse({ ok: false, error: 'Refugee no verificado' }, 403)

      // Verificar que no tiene ya un match activo
      const matchActivo = await env.DB.prepare(
        "SELECT id FROM matches WHERE refugee_id = ? AND estado IN ('activo', 'pendiente_host')"
      ).bind(refugeeId).first()
      if (matchActivo) return jsonResponse({ ok: false, error: 'Ya tienes un alojamiento activo o pendiente' }, 409)

      // Verificar listing disponible
      const listing = await env.DB.prepare(`
        SELECT l.*, u.telefono AS host_tel, u.nombre AS host_nombre
        FROM listings l JOIN users u ON u.id = l.host_id
        WHERE l.id = ? AND l.estado = 'disponible'
      `).bind(listingId).first() as Record<string, string> | null
      if (!listing) return jsonResponse({ ok: false, error: 'Listing no disponible' }, 404)

      const matchId = crypto.randomUUID()
      await env.DB.prepare(`
        INSERT INTO matches (id, listing_id, refugee_id, estado)
        VALUES (?, ?, ?, 'pendiente_host')
      `).bind(matchId, listingId, refugeeId).run()

      // Notificar al host
      await enviarWhatsApp(
        env, listing.host_tel, 'match_solicitud_host',
        [listing.host_nombre, refugee.nombre, refugee.telefono]
      )

      return jsonResponse({ ok: true, matchId, mensaje: 'Solicitud enviada al anfitrión. Te avisaremos cuando responda.' })
    }

    // ── POST /api/match/responder ─────────────────────────────
    if (request.method === 'POST' && path.endsWith('/responder')) {
      const { matchId, hostId, acepta } = await request.json() as {
        matchId: string; hostId: string; acepta: boolean
      }

      const match = await env.DB.prepare(`
        SELECT m.*, l.host_id,
               r.telefono AS refugee_tel, r.nombre AS refugee_nombre,
               h.telefono AS host_tel, h.nombre AS host_nombre
        FROM matches m
        JOIN listings l ON l.id = m.listing_id
        JOIN users r ON r.id = m.refugee_id
        JOIN users h ON h.id = l.host_id
        WHERE m.id = ? AND m.estado = 'pendiente_host'
      `).bind(matchId).first() as Record<string, string> | null

      if (!match) return jsonResponse({ ok: false, error: 'Match no encontrado' }, 404)
      if (match.host_id !== hostId) return jsonResponse({ ok: false, error: 'No autorizado' }, 403)

      const now = new Date()
      const nowIso = now.toISOString()

      if (acepta) {
        const fechaFin = addDays(now, 30)

        await env.DB.batch([
          env.DB.prepare(`
            UPDATE matches
            SET estado = 'activo', fecha_inicio = ?, fecha_fin = ?, updated_at = ?
            WHERE id = ?
          `).bind(nowIso, fechaFin, nowIso, matchId),
          env.DB.prepare(`
            UPDATE listings SET estado = 'ocupado', updated_at = ? WHERE id = ?
          `).bind(nowIso, match.listing_id),
        ])

        // Notificar a ambas partes
        await Promise.allSettled([
          enviarWhatsApp(env, match.refugee_tel, 'match_aceptado_refugee',
            [match.refugee_nombre, match.host_nombre, match.host_tel, fechaFin.split('T')[0]]),
          enviarWhatsApp(env, match.host_tel, 'match_aceptado_host',
            [match.host_nombre, match.refugee_nombre, fechaFin.split('T')[0]]),
        ])

        return jsonResponse({ ok: true, fechaFin, mensaje: 'Match activado. Ambas partes han sido notificadas.' })

      } else {
        await env.DB.prepare(`
          UPDATE matches SET estado = 'rechazado', updated_at = ? WHERE id = ?
        `).bind(nowIso, matchId).run()

        await enviarWhatsApp(env, match.refugee_tel, 'match_rechazado_refugee',
          [match.refugee_nombre])

        return jsonResponse({ ok: true, mensaje: 'Solicitud rechazada.' })
      }
    }

    // ── POST /api/match/renovar ───────────────────────────────
    if (request.method === 'POST' && path.endsWith('/renovar')) {
      const { matchId, refugeeId } = await request.json() as { matchId: string; refugeeId: string }

      const match = await env.DB.prepare(`
        SELECT m.*, r.nombre AS refugee_nombre, r.telefono AS refugee_tel,
               h.nombre AS host_nombre, h.telefono AS host_tel
        FROM matches m
        JOIN users r ON r.id = m.refugee_id
        JOIN listings l ON l.id = m.listing_id
        JOIN users h ON h.id = l.host_id
        WHERE m.id = ? AND m.refugee_id = ? AND m.estado = 'activo'
      `).bind(matchId, refugeeId).first() as Record<string, string> | null

      if (!match) return jsonResponse({ ok: false, error: 'Match activo no encontrado' }, 404)
      if (match.renovado === '1') return jsonResponse({ ok: false, error: 'Este alojamiento ya fue renovado. El máximo es 60 días.' }, 409)

      const fechaFinActual = new Date(match.fecha_fin)
      const diasRestantes = Math.ceil((fechaFinActual.getTime() - Date.now()) / 86400000)

      if (diasRestantes > 7) {
        return jsonResponse({ ok: false, error: `La renovación solo se puede solicitar en los últimos 7 días. Quedan ${diasRestantes} días.` }, 400)
      }

      const nuevaFechaFin = addDays(fechaFinActual, 30)

      await env.DB.prepare(`
        UPDATE matches SET renovado = 1, fecha_fin = ?, updated_at = ? WHERE id = ?
      `).bind(nuevaFechaFin, new Date().toISOString(), matchId).run()

      await Promise.allSettled([
        enviarWhatsApp(env, match.refugee_tel, 'renovacion_confirmada',
          [match.refugee_nombre, nuevaFechaFin.split('T')[0]]),
        enviarWhatsApp(env, match.host_tel, 'renovacion_notif_host',
          [match.host_nombre, match.refugee_nombre, nuevaFechaFin.split('T')[0]]),
      ])

      return jsonResponse({ ok: true, nuevaFechaFin, mensaje: 'Renovación aplicada. Período extendido 30 días más.' })
    }

    // ── POST /api/match/cancelar ──────────────────────────────
    if (request.method === 'POST' && path.endsWith('/cancelar')) {
      const { matchId, userId, motivo } = await request.json() as {
        matchId: string; userId: string; motivo: string
      }

      const match = await env.DB.prepare(`
        SELECT m.*, l.host_id,
               r.telefono AS refugee_tel, r.nombre AS refugee_nombre,
               h.telefono AS host_tel, h.nombre AS host_nombre
        FROM matches m
        JOIN listings l ON l.id = m.listing_id
        JOIN users r ON r.id = m.refugee_id
        JOIN users h ON h.id = l.host_id
        WHERE m.id = ? AND m.estado = 'activo'
      `).bind(matchId).first() as Record<string, string> | null

      if (!match) return jsonResponse({ ok: false, error: 'Match no encontrado' }, 404)

      const esParticipante = userId === match.refugee_id || userId === match.host_id
      if (!esParticipante) return jsonResponse({ ok: false, error: 'No autorizado' }, 403)

      const now = new Date().toISOString()
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE matches
          SET estado = 'cancelado', cancelado_por = ?, motivo_cancelacion = ?, updated_at = ?
          WHERE id = ?
        `).bind(userId, motivo ?? null, now, matchId),
        env.DB.prepare(`
          UPDATE listings SET estado = 'disponible', updated_at = ? WHERE id = ?
        `).bind(now, match.listing_id),
      ])

      const canceladoPorHost = userId === match.host_id
      await Promise.allSettled([
        canceladoPorHost
          ? enviarWhatsApp(env, match.refugee_tel, 'match_cancelado_refugee', [match.refugee_nombre])
          : enviarWhatsApp(env, match.host_tel, 'match_cancelado_host', [match.host_nombre]),
      ])

      return jsonResponse({ ok: true, mensaje: 'Match cancelado. El espacio queda disponible nuevamente.' })
    }

    return jsonResponse({ ok: false, error: 'Ruta no encontrada' }, 404)
  }
}
