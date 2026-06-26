/**
 * refugio.com.ve — Worker: Cron de vencimientos
 * Se ejecuta diariamente a las 6:00 AM UTC (configurado en wrangler.toml)
 *
 * Tareas:
 * 1. Expirar matches vencidos → liberar listing
 * 2. Enviar recordatorio 7 días antes del vencimiento
 * 3. Enviar recordatorio 1 día antes del vencimiento
 */

export interface Env {
  DB:                        D1Database
  KV:                        KVNamespace
  WHATSAPP_API_TOKEN:        string
  WHATSAPP_PHONE_NUMBER_ID:  string
}

async function enviarWhatsApp(env: Env, telefono: string, template: string, params: string[]) {
  try {
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
  } catch (e) {
    console.error('WhatsApp error:', e)
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = new Date()
    const hoy = now.toISOString()

    console.log(`[Cron] Ejecutando vencimientos: ${hoy}`)

    // ── 1. Expirar matches vencidos ───────────────────────────
    const { results: vencidos } = await env.DB.prepare(`
      SELECT
        m.id AS match_id, m.listing_id,
        r.nombre AS refugee_nombre, r.telefono AS refugee_tel,
        h.nombre AS host_nombre, h.telefono AS host_tel
      FROM matches m
      JOIN users r ON r.id = m.refugee_id
      JOIN listings l ON l.id = m.listing_id
      JOIN users h ON h.id = l.host_id
      WHERE m.estado = 'activo' AND m.fecha_fin <= ?
    `).bind(hoy).all()

    for (const match of vencidos as Record<string, string>[]) {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE matches SET estado = 'finalizado', updated_at = ? WHERE id = ?
        `).bind(hoy, match.match_id),
        env.DB.prepare(`
          UPDATE listings SET estado = 'disponible', updated_at = ? WHERE id = ?
        `).bind(hoy, match.listing_id),
      ])

      await Promise.allSettled([
        enviarWhatsApp(env, match.refugee_tel, 'match_vencido_refugee',
          [match.refugee_nombre]),
        enviarWhatsApp(env, match.host_tel, 'match_vencido_host',
          [match.host_nombre, match.refugee_nombre]),
      ])

      console.log(`[Cron] Match vencido procesado: ${match.match_id}`)
    }

    // ── 2. Recordatorio 7 días antes ──────────────────────────
    const en7Dias = new Date(now)
    en7Dias.setDate(en7Dias.getDate() + 7)
    const en7DiasFecha = en7Dias.toISOString().split('T')[0]

    const { results: porVencer7 } = await env.DB.prepare(`
      SELECT
        m.id AS match_id, m.fecha_fin, m.renovado,
        r.nombre AS refugee_nombre, r.telefono AS refugee_tel,
        h.nombre AS host_nombre, h.telefono AS host_tel
      FROM matches m
      JOIN users r ON r.id = m.refugee_id
      JOIN listings l ON l.id = m.listing_id
      JOIN users h ON h.id = l.host_id
      WHERE m.estado = 'activo'
        AND substr(m.fecha_fin, 1, 10) = ?
    `).bind(en7DiasFecha).all()

    for (const match of porVencer7 as Record<string, string>[]) {
      const puedeRenovar = match.renovado === '0'
      const templateRefugee = puedeRenovar
        ? 'recordatorio_7dias_con_renovacion'
        : 'recordatorio_7dias_sin_renovacion'

      await Promise.allSettled([
        enviarWhatsApp(env, match.refugee_tel, templateRefugee,
          [match.refugee_nombre, match.fecha_fin.split('T')[0]]),
        enviarWhatsApp(env, match.host_tel, 'recordatorio_7dias_host',
          [match.host_nombre, match.refugee_nombre, match.fecha_fin.split('T')[0]]),
      ])
    }

    // ── 3. Recordatorio 1 día antes ───────────────────────────
    const manana = new Date(now)
    manana.setDate(manana.getDate() + 1)
    const mañanaFecha = manana.toISOString().split('T')[0]

    const { results: porVencer1 } = await env.DB.prepare(`
      SELECT
        m.id AS match_id, m.fecha_fin,
        r.nombre AS refugee_nombre, r.telefono AS refugee_tel,
        h.nombre AS host_nombre, h.telefono AS host_tel
      FROM matches m
      JOIN users r ON r.id = m.refugee_id
      JOIN listings l ON l.id = m.listing_id
      JOIN users h ON h.id = l.host_id
      WHERE m.estado = 'activo'
        AND substr(m.fecha_fin, 1, 10) = ?
    `).bind(mañanaFecha).all()

    for (const match of porVencer1 as Record<string, string>[]) {
      await Promise.allSettled([
        enviarWhatsApp(env, match.refugee_tel, 'recordatorio_1dia_refugee',
          [match.refugee_nombre]),
        enviarWhatsApp(env, match.host_tel, 'recordatorio_1dia_host',
          [match.host_nombre, match.refugee_nombre]),
      ])
    }

    console.log(`[Cron] Completado — Vencidos: ${vencidos.length}, Por vencer 7d: ${porVencer7.length}, Por vencer 1d: ${porVencer1.length}`)
  }
}
