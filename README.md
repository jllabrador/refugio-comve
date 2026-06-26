# refugio.com.ve

Plataforma humanitaria de alojamiento temporal para damnificados del terremoto de Venezuela 2026.
Sin fines de lucro · Gratuita · Temporal (máx. 60 días)

---

## Setup inicial (primera vez)

### 1. Requisitos
- Node.js 20+
- Cuenta Cloudflare personal (NO usar la de Galait)
- Cuenta Clerk personal: https://clerk.com
- Cuenta Resend personal: https://resend.com
- Cuenta Meta Business con WhatsApp Business API (número separado)

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar Cloudflare
```bash
# Login con cuenta personal
npx wrangler login

# Crear base de datos D1
npx wrangler d1 create refugio-db
# → Copiar el database_id al wrangler.toml

# Crear bucket R2 para documentos
npx wrangler r2 bucket create refugio-docs

# Crear namespace KV
npx wrangler kv namespace create refugio-kv
# → Copiar el id al wrangler.toml

# Aplicar schema de base de datos
npx wrangler d1 execute refugio-db --file=schema.sql
```

### 4. Configurar variables de entorno
```bash
cp .env.example .env.local
# Editar .env.local con tus credenciales reales
```

### 5. Configurar secrets en Cloudflare (producción)
```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put WHATSAPP_API_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_MODERADOR_NUMBER
npx wrangler secret put RESEND_API_KEY
```

### 6. Desarrollo local
```bash
npm run dev
# Frontend: http://localhost:3000

# Workers locales (en otra terminal)
npx wrangler dev workers/registro/index.ts --port 8787
npx wrangler dev workers/verificacion/index.ts --port 8788
npx wrangler dev workers/match/index.ts --port 8789
```

### 7. Deploy a producción
```bash
npm run deploy
# O por separado:
npm run build
npx wrangler pages deploy .next
```

---

## Estructura del proyecto

```
refugio-comve/
├── app/                    # Next.js App Router
│   ├── page/               # Landing principal
│   ├── registro/           # Formularios de alta
│   ├── listings/           # Búsqueda de espacios
│   └── admin/              # Panel moderación (protegido)
├── workers/
│   ├── registro/           # POST /api/registro
│   ├── verificacion/       # GET|POST /api/verificacion/*
│   ├── match/              # GET|POST /api/match/*
│   └── cron/               # Vencimientos automáticos (6AM UTC)
├── lib/
│   ├── db/                 # Helpers D1
│   ├── auth/               # Clerk helpers
│   ├── whatsapp/           # Templates WhatsApp
│   └── email/              # Resend helpers
├── schema.sql              # Schema completo D1
├── wrangler.toml           # Config Cloudflare
└── .env.example            # Variables de entorno
```

---

## Templates WhatsApp a crear en Meta

Crear estos templates en Meta Business Manager antes del lanzamiento:

| Template | Uso | Parámetros |
|---|---|---|
| `registro_recibido` | Usuario registrado | {nombre} |
| `nuevo_registro_moderacion` | Alerta a moderador | {tipo}, {nombre}, {userId} |
| `verificacion_aprobada` | Usuario aprobado | {nombre} |
| `verificacion_rechazada` | Usuario rechazado | {nombre}, {motivo} |
| `match_solicitud_host` | Host recibe solicitud | {host_nombre}, {refugee_nombre}, {refugee_tel} |
| `match_aceptado_refugee` | Refugee: match aceptado | {nombre}, {host_nombre}, {host_tel}, {fecha_fin} |
| `match_aceptado_host` | Host: match confirmado | {nombre}, {refugee_nombre}, {fecha_fin} |
| `match_rechazado_refugee` | Refugee: match rechazado | {nombre} |
| `match_vencido_refugee` | Período terminado | {nombre} |
| `match_vencido_host` | Período terminado (host) | {host_nombre}, {refugee_nombre} |
| `match_cancelado_refugee` | Cancelación notif | {nombre} |
| `match_cancelado_host` | Cancelación notif | {nombre} |
| `recordatorio_7dias_con_renovacion` | 7 días antes + puede renovar | {nombre}, {fecha_fin} |
| `recordatorio_7dias_sin_renovacion` | 7 días antes + no puede renovar | {nombre}, {fecha_fin} |
| `recordatorio_7dias_host` | 7 días antes (host) | {nombre}, {refugee_nombre}, {fecha_fin} |
| `recordatorio_1dia_refugee` | Último día | {nombre} |
| `recordatorio_1dia_host` | Último día (host) | {nombre}, {refugee_nombre} |
| `renovacion_confirmada` | Renovación OK | {nombre}, {nueva_fecha_fin} |
| `renovacion_notif_host` | Renovación notif host | {nombre}, {refugee_nombre}, {nueva_fecha_fin} |

---

## Costo estimado mensual

| Servicio | Free tier | Costo estimado |
|---|---|---|
| Cloudflare Pages | Ilimitado | $0 |
| Cloudflare Workers | 100K req/día | $0 |
| Cloudflare D1 | 5 GB + 25M reads | $0 |
| Cloudflare R2 | 10 GB | $0 |
| Clerk | 10K usuarios/mes | $0 |
| Resend | 3K emails/mes | $0 |
| WhatsApp Business API | 1K conv/mes | ~$0–5 |
| **Total** | | **~$0–5/mes** |

---

## Licencia

Este proyecto es de uso humanitario. Código abierto bajo MIT.
