/* =====================================================================
   Modelo de cobro tipo marketplace (como Freelancer):
   - Tarifa al cliente: % de lo cobrado (mínimo por servicio), línea propia en la factura.
   - Comisión al prestador: % del valor del servicio (mínimo), cargada al aceptar la asignación;
     también sobre materiales y cargos adicionales.
   - Membresía opcional del prestador: planes con comisión reducida, prioridad y destacado.
   - Estado de cuenta del prestador (movimientos) y liquidaciones.
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO

-- Parámetros de cobro (editables por administración)
IF OBJECT_ID('ajustes_plataforma') IS NULL
  CREATE TABLE ajustes_plataforma (
    clave       NVARCHAR(50)  NOT NULL PRIMARY KEY,
    valor       DECIMAL(12,2) NOT NULL CHECK (valor >= 0),
    descripcion NVARCHAR(200) NULL
  );
GO
MERGE ajustes_plataforma AS t
USING (VALUES
  (N'comision_pct',       10.00, N'Comisión al prestador (% del valor del servicio sin ITBIS)'),
  (N'comision_min',      300.00, N'Comisión mínima por servicio aceptado (RD$)'),
  (N'tarifa_cliente_pct',  3.00, N'Tarifa de servicio al cliente (% de lo cobrado sin ITBIS)'),
  (N'tarifa_cliente_min',180.00, N'Tarifa mínima al cliente por servicio (RD$)')
) AS s (clave, valor, descripcion) ON t.clave = s.clave
WHEN NOT MATCHED THEN INSERT (clave, valor, descripcion) VALUES (s.clave, s.valor, s.descripcion);
GO

-- Tarifa al cliente fijada al crear la solicitud (NULL = solicitud anterior, sin tarifa)
IF COL_LENGTH('solicitudes_servicio', 'tarifa_pct') IS NULL ALTER TABLE solicitudes_servicio ADD tarifa_pct DECIMAL(5,2) NULL;
IF COL_LENGTH('solicitudes_servicio', 'tarifa_min') IS NULL ALTER TABLE solicitudes_servicio ADD tarifa_min DECIMAL(12,2) NULL;
GO

-- Comisión fijada al aceptar la asignación
IF COL_LENGTH('asignaciones_servicio', 'comision_pct') IS NULL ALTER TABLE asignaciones_servicio ADD comision_pct DECIMAL(5,2) NULL;
IF COL_LENGTH('asignaciones_servicio', 'comision_monto') IS NULL ALTER TABLE asignaciones_servicio ADD comision_monto DECIMAL(12,2) NULL;
GO

-- Planes para clientes o para prestadores (membresía)
IF COL_LENGTH('planes', 'dirigido_a') IS NULL
  ALTER TABLE planes ADD dirigido_a NVARCHAR(10) NOT NULL CONSTRAINT DF_planes_dirigido_a DEFAULT N'Cliente'
    CONSTRAINT CK_planes_dirigido_a CHECK (dirigido_a IN (N'Cliente', N'Prestador'));
IF COL_LENGTH('planes', 'comision_pct') IS NULL ALTER TABLE planes ADD comision_pct DECIMAL(5,2) NULL;
IF COL_LENGTH('planes', 'prioridad_asignacion') IS NULL ALTER TABLE planes ADD prioridad_asignacion BIT NOT NULL CONSTRAINT DF_planes_prioridad DEFAULT 0;
IF COL_LENGTH('planes', 'destacado') IS NULL ALTER TABLE planes ADD destacado BIT NOT NULL CONSTRAINT DF_planes_destacado DEFAULT 0;
GO

-- Estado de cuenta del prestador: monto > 0 a su favor, < 0 en su contra
IF OBJECT_ID('liquidaciones_prestador') IS NULL
  CREATE TABLE liquidaciones_prestador (
    id_liquidacion INT IDENTITY PRIMARY KEY,
    id_empleado    INT NOT NULL REFERENCES empleados (id_empleado),
    sentido        NVARCHAR(20) NOT NULL CHECK (sentido IN (N'Pago al prestador', N'Cobro al prestador')),
    monto          DECIMAL(12,2) NOT NULL CHECK (monto > 0),
    metodo         NVARCHAR(20) NOT NULL CHECK (metodo IN (N'Transferencia', N'Efectivo', N'PayPal')),
    referencia     NVARCHAR(60) NULL,
    observacion    NVARCHAR(200) NULL,
    fecha          DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    registrado_por INT NULL REFERENCES usuarios (id_usuario)
  );
GO
IF OBJECT_ID('movimientos_prestador') IS NULL
  CREATE TABLE movimientos_prestador (
    id_movimiento  INT IDENTITY PRIMARY KEY,
    id_empleado    INT NOT NULL REFERENCES empleados (id_empleado),
    tipo           NVARCHAR(30) NOT NULL CHECK (tipo IN (N'Servicio realizado', N'Comisión', N'Comisión extra', N'Efectivo cobrado',
                                                          N'Reverso', N'Liquidación')),
    descripcion    NVARCHAR(200) NOT NULL,
    monto          DECIMAL(12,2) NOT NULL,
    id_solicitud   INT NULL REFERENCES solicitudes_servicio (id_solicitud),
    id_asignacion  INT NULL REFERENCES asignaciones_servicio (id_asignacion),
    id_pago        INT NULL REFERENCES pagos (id_pago),
    id_liquidacion INT NULL REFERENCES liquidaciones_prestador (id_liquidacion),
    id_reversado   INT NULL REFERENCES movimientos_prestador (id_movimiento),
    fecha          DATETIME2 NOT NULL DEFAULT SYSDATETIME()
  );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_movimientos_prestador_empleado')
  CREATE INDEX IX_movimientos_prestador_empleado ON movimientos_prestador (id_empleado, fecha);
-- Un movimiento por concepto (evita duplicados si un evento se procesa dos veces)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_movimientos_prestador_pago')
  CREATE UNIQUE INDEX UX_movimientos_prestador_pago ON movimientos_prestador (id_pago, tipo) WHERE id_pago IS NOT NULL AND tipo <> N'Reverso';
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_movimientos_prestador_asignacion')
  CREATE UNIQUE INDEX UX_movimientos_prestador_asignacion ON movimientos_prestador (id_asignacion, tipo) WHERE id_asignacion IS NOT NULL AND tipo <> N'Reverso';
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_movimientos_prestador_reverso')
  CREATE UNIQUE INDEX UX_movimientos_prestador_reverso ON movimientos_prestador (id_reversado) WHERE id_reversado IS NOT NULL;
GO
