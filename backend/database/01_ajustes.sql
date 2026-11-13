/* =====================================================================
   Ajustes a la base GestionMultiservicios (SQL Server)
   Sistema de Gestión Multiservicios · Directorio Servicios, SRL

   La base ya tiene las 22 tablas de la sección 20. Este script:
     1. Elimina filas duplicadas de roles y planes (el script inicial se
        ejecutó 3 veces) y agrega índices únicos para que no se repita.
     2. Agrega columnas que usan los procesos del diseño.
     3. Crea 3 tablas de soporte: empleado_servicio, secuencias_ecf, bitacora.
   Es idempotente: se puede ejecutar varias veces sin efectos adicionales.
   ===================================================================== */
USE GestionMultiservicios;
GO

/* ---------- 1. Duplicados ---------- */
DELETE ps FROM plan_servicio ps
 WHERE EXISTS (SELECT 1 FROM planes p JOIN planes q ON q.nombre = p.nombre AND q.id_plan < p.id_plan WHERE p.id_plan = ps.id_plan);
DELETE p FROM planes p
 WHERE EXISTS (SELECT 1 FROM planes q WHERE q.nombre = p.nombre AND q.id_plan < p.id_plan)
   AND NOT EXISTS (SELECT 1 FROM suscripciones s WHERE s.id_plan = p.id_plan);
DELETE r FROM roles r
 WHERE EXISTS (SELECT 1 FROM roles q WHERE q.nombre_rol = r.nombre_rol AND q.id_rol < r.id_rol)
   AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id_rol = r.id_rol);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_roles_nombre_rol')
  CREATE UNIQUE INDEX UQ_roles_nombre_rol ON roles(nombre_rol);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_planes_nombre')
  CREATE UNIQUE INDEX UQ_planes_nombre ON planes(nombre);
GO

/* ---------- 2. Columnas adicionales ---------- */
-- Bloqueo de 15 minutos tras 3 intentos fallidos (25.3)
IF COL_LENGTH('usuarios', 'bloqueado_hasta') IS NULL ALTER TABLE usuarios ADD bloqueado_hasta DATETIME2 NULL;
-- Matriz de permisos editable en ADM-P04
IF COL_LENGTH('roles', 'permisos') IS NULL ALTER TABLE roles ADD permisos NVARCHAR(MAX) NULL;
-- Perfil del prestador (CAT-P02 / CAT-P03)
IF COL_LENGTH('empleados', 'total_resenas') IS NULL ALTER TABLE empleados ADD total_resenas INT NOT NULL CONSTRAINT DF_empleados_total_resenas DEFAULT 0;
IF COL_LENGTH('empleados', 'anios_experiencia') IS NULL ALTER TABLE empleados ADD anios_experiencia TINYINT NULL;
IF COL_LENGTH('empleados', 'horario') IS NULL ALTER TABLE empleados ADD horario NVARCHAR(100) NULL;
IF COL_LENGTH('empleados', 'presentacion') IS NULL ALTER TABLE empleados ADD presentacion NVARCHAR(500) NULL;
IF COL_LENGTH('empleados', 'documentos') IS NULL ALTER TABLE empleados ADD documentos NVARCHAR(MAX) NULL;
-- Ícono de la tarjeta del catálogo
IF COL_LENGTH('servicios', 'icono') IS NULL ALTER TABLE servicios ADD icono NVARCHAR(10) NULL;
-- Materiales agregados al cierre (16.5.3 C.4): línea sin servicio del catálogo
IF COL_LENGTH('solicitud_detalle', 'descripcion') IS NULL ALTER TABLE solicitud_detalle ADD descripcion NVARCHAR(150) NULL;
IF COL_LENGTH('solicitud_detalle', 'aplica_itbis') IS NULL ALTER TABLE solicitud_detalle ADD aplica_itbis BIT NOT NULL CONSTRAINT DF_solicitud_detalle_itbis DEFAULT 1;
ALTER TABLE solicitud_detalle ALTER COLUMN id_servicio INT NULL;
ALTER TABLE factura_detalle ALTER COLUMN id_servicio INT NULL;
-- Confirmación del cliente o automática a las 48 h
IF COL_LENGTH('solicitudes_servicio', 'fecha_finalizacion') IS NULL ALTER TABLE solicitudes_servicio ADD fecha_finalizacion DATETIME2 NULL;
-- Motivo de rechazo en conciliación (PAG-P06)
IF COL_LENGTH('pagos', 'observacion') IS NULL ALTER TABLE pagos ADD observacion NVARCHAR(200) NULL;
-- Motivo devuelto por la DGII
IF COL_LENGTH('ecf', 'mensaje_dgii') IS NULL ALTER TABLE ecf ADD mensaje_dgii NVARCHAR(250) NULL;
GO

/* ---------- 3. Tablas de soporte ---------- */
-- Servicios del catálogo que ofrece cada prestador (CAT-P03)
IF OBJECT_ID('empleado_servicio') IS NULL
CREATE TABLE empleado_servicio (
  id_empleado INT NOT NULL CONSTRAINT FK_empleado_servicio_empleado REFERENCES empleados(id_empleado) ON DELETE CASCADE,
  id_servicio INT NOT NULL CONSTRAINT FK_empleado_servicio_servicio REFERENCES servicios(id_servicio),
  CONSTRAINT PK_empleado_servicio PRIMARY KEY (id_empleado, id_servicio)
);

-- Secuencias de e-NCF autorizadas por la DGII (FAC-P03)
IF OBJECT_ID('secuencias_ecf') IS NULL
CREATE TABLE secuencias_ecf (
  id_secuencia INT IDENTITY(1,1) CONSTRAINT PK_secuencias_ecf PRIMARY KEY,
  tipo_ecf     CHAR(3)      NOT NULL CONSTRAINT CK_secuencias_tipo CHECK (tipo_ecf IN ('e31','e32')),
  desde        INT          NOT NULL,
  hasta        INT          NOT NULL,
  ultimo_usado INT          NOT NULL CONSTRAINT DF_secuencias_ultimo DEFAULT 0,
  vencimiento  DATE         NOT NULL,
  estado       NVARCHAR(15) NOT NULL CONSTRAINT DF_secuencias_estado DEFAULT N'Vigente'
               CONSTRAINT CK_secuencias_estado CHECK (estado IN (N'Vigente', N'Agotada', N'Vencida')),
  CONSTRAINT CK_secuencias_rango CHECK (desde >= 1 AND hasta >= desde AND hasta <= 9999999999)
);

-- Bitácora de auditoría (25.3)
IF OBJECT_ID('bitacora') IS NULL
CREATE TABLE bitacora (
  id_bitacora    INT IDENTITY(1,1) CONSTRAINT PK_bitacora PRIMARY KEY,
  id_usuario     INT           NULL,
  accion         NVARCHAR(80)  NOT NULL,
  entidad        NVARCHAR(40)  NULL,
  id_entidad     INT           NULL,
  valor_anterior NVARCHAR(MAX) NULL,
  valor_nuevo    NVARCHAR(MAX) NULL,
  ip             NVARCHAR(45)  NULL,
  fecha          DATETIME2     NOT NULL CONSTRAINT DF_bitacora_fecha DEFAULT SYSDATETIME()
);
GO

/* ---------- Índices de consulta frecuente ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_solicitudes_estado')
  CREATE INDEX IX_solicitudes_estado ON solicitudes_servicio(estado);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_pagos_estado')
  CREATE INDEX IX_pagos_estado ON pagos(estado);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_notificaciones_usuario')
  CREATE INDEX IX_notificaciones_usuario ON notificaciones(id_usuario, leida);
GO
