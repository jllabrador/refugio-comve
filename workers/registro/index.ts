/**
 * refugio.com.ve — Worker: Registro de usuarios
 * Ruta: POST /api/registro
 *
 * Maneja el alta de hosts y refugees con:
 * - Validación de campos
 * - Hash de cédula (nunca se guarda en plain text)
 * - Upload de documentos a R2
 * - Creación del registro en D1
 * - Notificación WhatsApp al equipo moderador
 */

import { z } from 'zod'

// ── Schemas de validación ────────────────────────────────────

const BaseSchema = z.object({
  tipo:      z.enum(['host', 'refugee']),
  nombre:    z.string().min(3).max(100),
  cedula:    z.string().regex(/^[VEJvej]-?\d{6,8}$/, 'Cédula venezolana inválida'),
  telefono:  z.string().regex(/^\+?58\d{10}$/, 'Teléfono venezolano inválido (+58XXXXXXXXXX)'),
  email:     z.string().email(),
  estado_venezolano: z.enum([
    'Amazonas','Anzoátegui','Apure','Aragua','Barinas','Bolívar',
    'Carabobo','Cojedes','Delta Amacuro','Distrito Capital','Falcón',
    'Guárico','Lara','Mérida','Miranda','Monagas','Nueva Esparta',
    'Portuguesa','Sucre','Táchira','Trujillo','La Guaira','Yaracuy',
    'Zulia','Dependencias Federales'
  ]),
  municipio: z.string().min(2).max(100),
})

const HostSchema = BaseSchema.extend({
  tipo:          z.literal('host'),
  tipo_espacio:  z.enum(['habitacion', 'cuarto', 'casa_completa', 'sofa_cama']),
  capacidad:     z.number().int().min(1).max(10),
  direccion:     z.string().min(10).max(300),
  tiene_agua:    z.boolean(),
  tiene_luz:     z.boolean(),
  tiene_gas:     z.boolean().default(false),
  tiene_wifi:    z.boolean().default(false),
  acepta_ninos:  z.boolean().default(true),
  acepta_mascotas: z.boolean().default(false),
  notas:         z.string().max(500).optional(),
})

const RefugeeSchema = BaseSchema.extend({
  tipo:          z.literal('refugee'),
  num_personas:  z.number().int().min(1).max(10),
  tiene_ninos:   z.boolean().default(false),
  tiene_mascotas: z.boolean().default(false),
  necesidades_especiales: z.string().max(300).optional(),
  zona_preferida: z.string().max(100).optional(),
})

// ── Utilidades ───────────────────────────────────────────────

async function hashCedula(cedula: string): Promise<string> {
  const normalized = cedula.toUpperCase().replace('-', '')
  const encoder = new TextEncoder()
  const data = encoder.encode(`refugio:${normalized}`)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

function generateId(): string {
  return crypto.randomUUID()
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://refugio.com.ve',
    },
  })
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ ok: false, error: message }, status)
}

// ── Notificación WhatsApp al equipo moderador ────────────────

async function notificarModerador(env: Env, tipo: string, nombre: string, userId: string) {
  const url = `https://graph.facebook.com/v19.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`
  const body = {
    messaging_product: 'whatsapp',
    to: env.WHATSAPP_MODERADOR_NUMBER,
    type: 'template',
    template: {
      name: 'nuevo_registro_moderacion',
      language: { code: 'es' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: tipo === 'host' ? 'Anfitrión' : 'Damnificado' },
          { type: 'text', text: nombre },
          { type: 'text', text: userId },
        ]
      }]
    }
  }

  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

// ── Notificación WhatsApp al usuario ─────────────────────────

async function notificarUsuario(env: Env, telefono: string, nombre: string) {
  const url = `https://graph.facebook.com/v19.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`
  const body = {
    messaging_product: 'whatsapp',
    to: telefono.replace('+', ''),
    type: 'template',
    template: {
      name: 'registro_recibido',
      language: { code: 'es' },
      components: [{
        type: 'body',
        parameters: [{ type: 'text', text: nombre }]
      }]
    }
  }

  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

// ── Handler principal ─────────────────────────────────────────

export interface Env {
  DB:                        D1Database
  DOCS:                      R2Bucket
  KV:                        KVNamespace
  WHATSAPP_API_TOKEN:        string
  WHATSAPP_PHONE_NUMBER_ID:  string
  WHATSAPP_MODERADOR_NUMBER: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': 'https://refugio.com.ve',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      })
    }

    if (request.method !== 'POST') return errorResponse('Método no permitido', 405)

    // ── Parsear body ─────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('JSON inválido')
    }

    // ── Determinar tipo y validar ─────────────────────────────
    const raw = body as Record<string, unknown>
    const tipo = raw?.tipo

    let data: z.infer<typeof HostSchema> | z.infer<typeof RefugeeSchema>
    if (tipo === 'host') {
      const result = HostSchema.safeParse(body)
      if (!result.success) return errorResponse(result.error.issues[0].message)
      data = result.data
    } else if (tipo === 'refugee') {
      const result = RefugeeSchema.safeParse(body)
      if (!result.success) return errorResponse(result.error.issues[0].message)
      data = result.data
    } else {
      return errorResponse('tipo debe ser "host" o "refugee"')
    }

    // ── Verificar cédula duplicada ────────────────────────────
    const cedulaHash = await hashCedula(data.cedula)
    const existing = await env.DB.prepare(
      'SELECT id FROM users WHERE cedula_hash = ?'
    ).bind(cedulaHash).first()

    if (existing) return errorResponse('Ya existe un registro con esa cédula', 409)

    // ── Verificar email duplicado ─────────────────────────────
    const existingEmail = await env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).bind(data.email).first()

    if (existingEmail) return errorResponse('Ya existe un registro con ese email', 409)

    // ── Crear usuario en D1 ───────────────────────────────────
    const userId = generateId()

    await env.DB.prepare(`
      INSERT INTO users
        (id, tipo, nombre, cedula_hash, telefono, email, estado, estado_venezolano, municipio)
      VALUES
        (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)
    `).bind(
      userId,
      data.tipo,
      data.nombre,
      cedulaHash,
      data.telefono,
      data.email,
      data.estado_venezolano,
      data.municipio,
    ).run()

    // ── Si es host, crear listing ─────────────────────────────
    if (data.tipo === 'host') {
      const hostData = data as z.infer<typeof HostSchema>
      const listingId = generateId()
      await env.DB.prepare(`
        INSERT INTO listings
          (id, host_id, tipo_espacio, capacidad, direccion,
           estado_venezolano, municipio,
           tiene_agua, tiene_luz, tiene_gas, tiene_wifi,
           acepta_ninos, acepta_mascotas, notas, estado)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suspendido')
      `).bind(
        listingId, userId,
        hostData.tipo_espacio,
        hostData.capacidad,
        hostData.direccion,
        hostData.estado_venezolano,
        hostData.municipio,
        hostData.tiene_agua ? 1 : 0,
        hostData.tiene_luz ? 1 : 0,
        hostData.tiene_gas ? 1 : 0,
        hostData.tiene_wifi ? 1 : 0,
        hostData.acepta_ninos ? 1 : 0,
        hostData.acepta_mascotas ? 1 : 0,
        hostData.notas ?? null,
      ).run()
    }

    // ── Guardar en KV para acceso rápido en verificación ─────
    await env.KV.put(`user:${userId}`, JSON.stringify({
      id: userId, tipo: data.tipo, nombre: data.nombre,
      estado: 'pendiente', created_at: new Date().toISOString()
    }), { expirationTtl: 60 * 60 * 24 * 90 }) // 90 días TTL

    // ── Notificaciones (no bloqueantes) ──────────────────────
    await Promise.allSettled([
      notificarModerador(env, data.tipo, data.nombre, userId),
      notificarUsuario(env, data.telefono, data.nombre),
    ])

    return jsonResponse({
      ok: true,
      userId,
      mensaje: 'Registro recibido. Recibirás confirmación en menos de 24 horas vía WhatsApp.',
    }, 201)
  }
}
