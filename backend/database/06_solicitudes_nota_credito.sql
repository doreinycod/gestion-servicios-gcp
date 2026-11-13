/* =====================================================================
   Solicitudes de nota de crédito del cliente.
   El cliente la pide desde Mis facturas; administración la aprueba (se emite la e34)
   o la rechaza. Si hubo pago, queda pendiente la devolución del dinero.
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO
IF OBJECT_ID('solicitudes_nota_credito') IS NULL
CREATE TABLE solicitudes_nota_credito (
  id_solicitud_nc     INT IDENTITY(1,1) CONSTRAINT PK_solicitudes_nota_credito PRIMARY KEY,
  id_factura          INT NOT NULL CONSTRAINT FK_snc_factura REFERENCES facturas (id_factura),
  id_cliente          INT NOT NULL CONSTRAINT FK_snc_cliente REFERENCES clientes (id_cliente),
  motivo              NVARCHAR(40) NOT NULL,
  detalle             NVARCHAR(500) NOT NULL,
  tipo                NVARCHAR(10) NOT NULL CONSTRAINT DF_snc_tipo DEFAULT N'Total',
  monto               DECIMAL(12,2) NULL,              -- con ITBIS; solo si es parcial
  estado              NVARCHAR(12) NOT NULL CONSTRAINT DF_snc_estado DEFAULT N'Pendiente',
  fecha_solicitud     DATETIME2 NOT NULL CONSTRAINT DF_snc_fecha DEFAULT SYSDATETIME(),
  fecha_respuesta     DATETIME2 NULL,
  respondido_por      INT NULL CONSTRAINT FK_snc_usuario REFERENCES usuarios (id_usuario),
  respuesta           NVARCHAR(300) NULL,
  id_nota             INT NULL CONSTRAINT FK_snc_nota REFERENCES facturas (id_factura),
  monto_acreditado    DECIMAL(12,2) NULL,
  requiere_devolucion BIT NOT NULL CONSTRAINT DF_snc_devolucion DEFAULT 0,
  fecha_devolucion    DATETIME2 NULL,
  referencia_devolucion NVARCHAR(60) NULL,
  CONSTRAINT CK_snc_motivo CHECK (motivo IN (N'Cobro de más', N'Servicio no realizado', N'Servicio incompleto o deficiente', N'Error en la factura', N'Otro')),
  CONSTRAINT CK_snc_tipo CHECK (tipo IN (N'Total', N'Parcial')),
  CONSTRAINT CK_snc_monto CHECK ((tipo = N'Total' AND monto IS NULL) OR (tipo = N'Parcial' AND monto > 0)),
  CONSTRAINT CK_snc_estado CHECK (estado IN (N'Pendiente', N'Aprobada', N'Rechazada', N'Cancelada'))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_snc_estado')
  CREATE INDEX IX_snc_estado ON solicitudes_nota_credito (estado, fecha_solicitud);
-- Una sola solicitud pendiente por documento
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_snc_pendiente')
  CREATE UNIQUE INDEX UX_snc_pendiente ON solicitudes_nota_credito (id_factura) WHERE estado = N'Pendiente';
GO
