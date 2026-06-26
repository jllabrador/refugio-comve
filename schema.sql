-- ============================================================
-- refugio.com.ve — Schema D1 (SQLite)
-- Ejecutar: wrangler d1 execute refugio-db --file=schema.sql
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Usuarios ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,          -- UUID generado en el Worker
  clerk_id        TEXT UNIQUE,               -- ID de sesión Clerk
  tipo            TEXT NOT NULL CHECK (tipo IN ('host', 'refugee', 'moderator')),
  nombre          TEXT NOT NULL,
  cedula_hash     TEXT UNIQUE NOT NULL,      -- SHA-256 de la cédula, nunca plain text
  telefono        TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente', 'verificado', 'suspendido', 'rechazado')),
  estado_venezolano TEXT,                    -- Yaracuy, Caracas, La Guaira, etc.
  municipio       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at     TEXT,
  suspended_at    TEXT,
  suspension_motivo TEXT
);

-- ── Listings (espacios ofrecidos por hosts) ──────────────────
CREATE TABLE IF NOT EXISTS listings (
  id              TEXT PRIMARY KEY,
  host_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  estado          TEXT NOT NULL DEFAULT 'disponible'
                  CHECK (estado IN ('disponible', 'ocupado', 'expirado', 'suspendido')),
  capacidad       INTEGER NOT NULL DEFAULT 1 CHECK (capacidad BETWEEN 1 AND 10),
  tipo_espacio    TEXT NOT NULL CHECK (tipo_espacio IN ('habitacion', 'cuarto', 'casa_completa', 'sofa_cama')),
  direccion       TEXT NOT NULL,
  estado_venezolano TEXT NOT NULL,
  municipio       TEXT NOT NULL,
  tiene_agua      INTEGER NOT NULL DEFAULT 1,
  tiene_luz       INTEGER NOT NULL DEFAULT 1,
  tiene_gas       INTEGER NOT NULL DEFAULT 0,
  tiene_wifi      INTEGER NOT NULL DEFAULT 0,
  acepta_ninos    INTEGER NOT NULL DEFAULT 1,
  acepta_mascotas INTEGER NOT NULL DEFAULT 0,
  notas           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Matches (conexiones host ↔ refugee) ──────────────────────
CREATE TABLE IF NOT EXISTS matches (
  id              TEXT PRIMARY KEY,
  listing_id      TEXT NOT NULL REFERENCES listings(id),
  refugee_id      TEXT NOT NULL REFERENCES users(id),
  estado          TEXT NOT NULL DEFAULT 'pendiente_host'
                  CHECK (estado IN ('pendiente_host', 'activo', 'finalizado', 'cancelado', 'rechazado')),
  fecha_inicio    TEXT,
  fecha_fin       TEXT,                      -- fecha_inicio + 30 días
  renovado        INTEGER NOT NULL DEFAULT 0 CHECK (renovado IN (0, 1)),
  renovacion_solicitada INTEGER NOT NULL DEFAULT 0,
  cancelado_por   TEXT,
  motivo_cancelacion TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Documentos de verificación ───────────────────────────────
CREATE TABLE IF NOT EXISTS verification_docs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo_doc        TEXT NOT NULL CHECK (tipo_doc IN ('cedula', 'foto_espacio', 'constancia_pc', 'foto_dano', 'otro')),
  r2_key          TEXT NOT NULL UNIQUE,      -- Ruta en el bucket R2
  estado          TEXT NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente', 'aprobado', 'rechazado')),
  revisor_id      TEXT REFERENCES users(id),
  notas_revisor   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at     TEXT
);

-- ── Reportes y denuncias ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS reportes (
  id              TEXT PRIMARY KEY,
  reportado_por   TEXT NOT NULL REFERENCES users(id),
  reportado_user  TEXT NOT NULL REFERENCES users(id),
  match_id        TEXT REFERENCES matches(id),
  tipo            TEXT NOT NULL CHECK (tipo IN ('cobro_ilegal', 'maltrato', 'fraude', 'abandono', 'otro')),
  descripcion     TEXT NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'abierto'
                  CHECK (estado IN ('abierto', 'en_revision', 'resuelto', 'cerrado')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);

-- ── Log de notificaciones enviadas ───────────────────────────
CREATE TABLE IF NOT EXISTS notificaciones (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  canal           TEXT NOT NULL CHECK (canal IN ('whatsapp', 'email')),
  tipo            TEXT NOT NULL,             -- 'verificacion_aprobada', 'match_nuevo', etc.
  estado          TEXT NOT NULL DEFAULT 'enviado'
                  CHECK (estado IN ('enviado', 'fallido')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Índices para queries frecuentes ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_estado       ON users(estado);
CREATE INDEX IF NOT EXISTS idx_users_tipo         ON users(tipo);
CREATE INDEX IF NOT EXISTS idx_listings_estado    ON listings(estado);
CREATE INDEX IF NOT EXISTS idx_listings_estado_ve ON listings(estado_venezolano);
CREATE INDEX IF NOT EXISTS idx_matches_refugee    ON matches(refugee_id);
CREATE INDEX IF NOT EXISTS idx_matches_listing    ON matches(listing_id);
CREATE INDEX IF NOT EXISTS idx_matches_estado     ON matches(estado);
CREATE INDEX IF NOT EXISTS idx_matches_fecha_fin  ON matches(fecha_fin);
CREATE INDEX IF NOT EXISTS idx_docs_user          ON verification_docs(user_id);
CREATE INDEX IF NOT EXISTS idx_docs_estado        ON verification_docs(estado);
