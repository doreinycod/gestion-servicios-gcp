/* =====================================================================
   Comprobante fiscal elegido por el cliente al pagar (consumo e32 o crédito fiscal e31).
   Se guarda en la solicitud para que anticipo y saldo salgan con el mismo comprobante,
   incluso si el cobro lo registra el prestador en efectivo.
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO
IF COL_LENGTH('solicitudes_servicio', 'comprobante_tipo') IS NULL ALTER TABLE solicitudes_servicio ADD comprobante_tipo CHAR(3) NULL;
IF COL_LENGTH('solicitudes_servicio', 'comprobante_rnc') IS NULL ALTER TABLE solicitudes_servicio ADD comprobante_rnc NVARCHAR(11) NULL;
IF COL_LENGTH('solicitudes_servicio', 'comprobante_razon') IS NULL ALTER TABLE solicitudes_servicio ADD comprobante_razon NVARCHAR(150) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_solicitudes_comprobante')
  ALTER TABLE solicitudes_servicio ADD CONSTRAINT CK_solicitudes_comprobante
    CHECK (comprobante_tipo IS NULL OR comprobante_tipo = 'e32' OR (comprobante_tipo = 'e31' AND comprobante_rnc IS NOT NULL AND comprobante_razon IS NOT NULL));
GO
