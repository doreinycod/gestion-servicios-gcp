/* =====================================================================
   Notas de crédito (e34), notas de débito (e33) y sustitución e32 → e31.
   - Las notas son filas de facturas (tipo_documento) que referencian la factura
     modificada (InformacionReferencia del formato e-CF v1.0).
   - Cargos adicionales: el prestador los solicita, el cliente los acepta y su pago
     genera la nota de débito.
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO
-- ---------- facturas: tipo de documento, referencia y datos fiscales del comprador ----------
IF COL_LENGTH('facturas', 'tipo_documento') IS NULL
  ALTER TABLE facturas ADD tipo_documento NVARCHAR(20) NOT NULL CONSTRAINT DF_facturas_tipo_documento DEFAULT N'Factura';
IF COL_LENGTH('facturas', 'id_factura_origen') IS NULL ALTER TABLE facturas ADD id_factura_origen INT NULL;
-- 1 anula, 2 corrige texto, 3 corrige montos, 5 referencia factura de consumo (e31 que sustituye un e32)
IF COL_LENGTH('facturas', 'codigo_modificacion') IS NULL ALTER TABLE facturas ADD codigo_modificacion TINYINT NULL;
IF COL_LENGTH('facturas', 'razon_modificacion') IS NULL ALTER TABLE facturas ADD razon_modificacion NVARCHAR(90) NULL;
-- Tipo de e-CF que corresponde al documento (e31, e32, e33, e34) y comprador tal como se declaró
IF COL_LENGTH('facturas', 'tipo_ecf') IS NULL ALTER TABLE facturas ADD tipo_ecf CHAR(3) NULL;
IF COL_LENGTH('facturas', 'rnc_comprador') IS NULL ALTER TABLE facturas ADD rnc_comprador NVARCHAR(11) NULL;
IF COL_LENGTH('facturas', 'razon_social_comprador') IS NULL ALTER TABLE facturas ADD razon_social_comprador NVARCHAR(150) NULL;
-- Nota de crédito que revierte una nota de débito. La DGII no permite que una nota modifique a otra (regla 655):
-- la NC referencia la factura original (id_factura_origen) y aquí se guarda la ND que deja sin efecto.
IF COL_LENGTH('facturas', 'id_nota_revertida') IS NULL ALTER TABLE facturas ADD id_nota_revertida INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_facturas_nota_revertida')
  ALTER TABLE facturas ADD CONSTRAINT FK_facturas_nota_revertida FOREIGN KEY (id_nota_revertida) REFERENCES facturas (id_factura);
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_facturas_tipo_documento')
  ALTER TABLE facturas ADD CONSTRAINT CK_facturas_tipo_documento CHECK (tipo_documento IN (N'Factura', N'Nota de crédito', N'Nota de débito'));
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_facturas_tipo_ecf')
  ALTER TABLE facturas ADD CONSTRAINT CK_facturas_tipo_ecf CHECK (tipo_ecf IS NULL OR tipo_ecf IN ('e31', 'e32', 'e33', 'e34'));
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_facturas_codigo_modificacion')
  ALTER TABLE facturas ADD CONSTRAINT CK_facturas_codigo_modificacion CHECK (codigo_modificacion IS NULL OR codigo_modificacion BETWEEN 1 AND 5);
-- Una nota siempre referencia el documento que modifica
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_facturas_nota_origen')
  ALTER TABLE facturas ADD CONSTRAINT CK_facturas_nota_origen CHECK (tipo_documento = N'Factura' OR (id_factura_origen IS NOT NULL AND codigo_modificacion IS NOT NULL));
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_facturas_origen')
  ALTER TABLE facturas ADD CONSTRAINT FK_facturas_origen FOREIGN KEY (id_factura_origen) REFERENCES facturas (id_factura);
GO
-- La nota de crédito no tiene pago. Un pago tiene un solo documento vigente:
-- al sustituir un e32 por un e31, el e32 queda Anulado y el e31 toma el mismo pago.
IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_facturas_id_pago') ALTER TABLE facturas DROP CONSTRAINT UQ_facturas_id_pago;
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_facturas_id_pago' AND object_id = OBJECT_ID('facturas')) DROP INDEX UQ_facturas_id_pago ON facturas;
GO
IF COLUMNPROPERTY(OBJECT_ID('facturas'), 'id_pago', 'AllowsNull') = 0 ALTER TABLE facturas ALTER COLUMN id_pago INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_facturas_pago_vigente')
  CREATE UNIQUE INDEX UX_facturas_pago_vigente ON facturas (id_pago) WHERE id_pago IS NOT NULL AND estado = N'Emitida';
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_facturas_id_pago')
  CREATE INDEX IX_facturas_id_pago ON facturas (id_pago);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_facturas_origen')
  CREATE INDEX IX_facturas_origen ON facturas (id_factura_origen) WHERE id_factura_origen IS NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_facturas_pago_documento')
  ALTER TABLE facturas ADD CONSTRAINT CK_facturas_pago_documento CHECK (id_pago IS NOT NULL OR tipo_documento = N'Nota de crédito');
GO
-- Datos de los documentos existentes (antes de esta versión todos eran facturas)
UPDATE f SET tipo_ecf = e.tipo_ecf FROM facturas f JOIN ecf e ON e.id_factura = f.id_factura WHERE f.tipo_ecf IS NULL;
UPDATE f SET rnc_comprador = NULLIF(REPLACE(REPLACE(c.rnc_cedula, '-', ''), ' ', ''), ''),
             razon_social_comprador = IIF(f.tipo_ecf = 'e31' OR NULLIF(c.rnc_cedula, '') IS NOT NULL,
                                          LEFT(COALESCE(c.razon_social, CONCAT(u.nombre, ' ', u.apellido)), 150), NULL)
  FROM facturas f JOIN clientes c ON c.id_cliente = f.id_cliente JOIN usuarios u ON u.id_usuario = c.id_usuario
 WHERE f.rnc_comprador IS NULL AND f.razon_social_comprador IS NULL AND f.tipo_ecf IS NOT NULL;
GO
-- ---------- ecf: tipos 33 y 34 ----------
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ecf_tipo_ecf') ALTER TABLE ecf DROP CONSTRAINT CK_ecf_tipo_ecf;
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ecf_ncf') ALTER TABLE ecf DROP CONSTRAINT CK_ecf_ncf;
GO
ALTER TABLE ecf ADD CONSTRAINT CK_ecf_tipo_ecf CHECK (tipo_ecf IN ('e31', 'e32', 'e33', 'e34'));
ALTER TABLE ecf ADD CONSTRAINT CK_ecf_ncf CHECK (ncf LIKE 'E3[1-4][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]');
GO
-- Secuencias locales (solo modo simulado) para notas
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_secuencias_tipo')
  ALTER TABLE secuencias_ecf DROP CONSTRAINT CK_secuencias_tipo;
GO
ALTER TABLE secuencias_ecf ADD CONSTRAINT CK_secuencias_tipo CHECK (tipo_ecf IN ('e31', 'e32', 'e33', 'e34'));
GO
IF NOT EXISTS (SELECT 1 FROM secuencias_ecf WHERE tipo_ecf = 'e33')
  INSERT INTO secuencias_ecf (tipo_ecf, desde, hasta, ultimo_usado, vencimiento) VALUES ('e33', 1, 500, 0, DATEADD(YEAR, 2, CAST(GETDATE() AS date)));
IF NOT EXISTS (SELECT 1 FROM secuencias_ecf WHERE tipo_ecf = 'e34')
  INSERT INTO secuencias_ecf (tipo_ecf, desde, hasta, ultimo_usado, vencimiento) VALUES ('e34', 1, 500, 0, DATEADD(YEAR, 2, CAST(GETDATE() AS date)));
GO
-- ---------- Cargos adicionales (nota de débito) ----------
IF OBJECT_ID('cargos_adicionales') IS NULL
CREATE TABLE cargos_adicionales (
  id_cargo         INT IDENTITY(1,1) CONSTRAINT PK_cargos_adicionales PRIMARY KEY,
  id_solicitud     INT NOT NULL CONSTRAINT FK_cargos_solicitud REFERENCES solicitudes_servicio (id_solicitud),
  id_empleado      INT NOT NULL CONSTRAINT FK_cargos_empleado REFERENCES empleados (id_empleado),
  descripcion      NVARCHAR(150) NOT NULL,
  motivo           NVARCHAR(300) NULL,
  cantidad         SMALLINT NOT NULL CONSTRAINT DF_cargos_cantidad DEFAULT 1,
  precio_unitario  DECIMAL(10,2) NOT NULL,
  aplica_itbis     BIT NOT NULL CONSTRAINT DF_cargos_itbis DEFAULT 1,
  estado           NVARCHAR(15) NOT NULL CONSTRAINT DF_cargos_estado DEFAULT N'Pendiente',
  fecha_solicitud  DATETIME2 NOT NULL CONSTRAINT DF_cargos_fecha DEFAULT SYSDATETIME(),
  fecha_respuesta  DATETIME2 NULL,
  motivo_rechazo   NVARCHAR(200) NULL,
  CONSTRAINT CK_cargos_estado CHECK (estado IN (N'Pendiente', N'Aceptado', N'Rechazado', N'Pagado', N'Anulado')),
  CONSTRAINT CK_cargos_cantidad CHECK (cantidad BETWEEN 1 AND 99),
  CONSTRAINT CK_cargos_precio CHECK (precio_unitario > 0)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_cargos_solicitud')
  CREATE INDEX IX_cargos_solicitud ON cargos_adicionales (id_solicitud, estado);
GO
-- ---------- pagos: cobro de un cargo adicional ----------
IF COL_LENGTH('pagos', 'id_cargo') IS NULL
  ALTER TABLE pagos ADD id_cargo INT NULL CONSTRAINT FK_pagos_cargo REFERENCES cargos_adicionales (id_cargo);
GO
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_pagos_tipo_pago') ALTER TABLE pagos DROP CONSTRAINT CK_pagos_tipo_pago;
GO
ALTER TABLE pagos ADD CONSTRAINT CK_pagos_tipo_pago CHECK (tipo_pago IN (N'Total', N'Anticipo', N'Saldo', N'Cargo'));
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_pagos_cargo')
  ALTER TABLE pagos ADD CONSTRAINT CK_pagos_cargo CHECK ((tipo_pago = N'Cargo' AND id_cargo IS NOT NULL) OR (tipo_pago <> N'Cargo' AND id_cargo IS NULL));
GO
