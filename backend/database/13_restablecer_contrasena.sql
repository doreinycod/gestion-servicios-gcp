/* =====================================================================
   "¿Olvidaste tu contraseña?": enlaces de restablecimiento de un solo uso.
   Se guarda solo el SHA-256 del token (el token viaja únicamente en el correo),
   vence a los 30 minutos y queda inválido al usarse o al pedir otro.
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO
IF OBJECT_ID('restablecimientos_contrasena') IS NULL
  CREATE TABLE restablecimientos_contrasena (
    id_restablecimiento INT IDENTITY PRIMARY KEY,
    id_usuario          INT NOT NULL REFERENCES usuarios (id_usuario),
    token_hash          CHAR(64) NOT NULL CONSTRAINT UX_restablecimientos_token UNIQUE,
    fecha_solicitud     DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    expira              DATETIME2 NOT NULL,
    fecha_uso           DATETIME2 NULL,
    ip                  NVARCHAR(45) NULL
  );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_restablecimientos_usuario')
  CREATE INDEX IX_restablecimientos_usuario ON restablecimientos_contrasena (id_usuario, fecha_solicitud);
GO
