/* =====================================================================
   Integración con el proveedor de facturación electrónica (plataforma e-CF).
   El proveedor asigna el e-NCF, firma con el certificado .p12, envía a la DGII
   y devuelve TrackId, estado, código de seguridad y la URL de consulta (QR).
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO
-- Identificador del documento en la plataforma del proveedor (para consultar estado y XML)
IF COL_LENGTH('ecf', 'proveedor_id') IS NULL ALTER TABLE ecf ADD proveedor_id NVARCHAR(40) NULL;
-- URL oficial de consulta en la DGII (contenido del código QR de la representación impresa)
IF COL_LENGTH('ecf', 'url_consulta') IS NULL ALTER TABLE ecf ADD url_consulta NVARCHAR(600) NULL;
-- Datos del emisor tal como se enviaron a la DGII (RNC, razón social, dirección…)
IF COL_LENGTH('ecf', 'emisor_json') IS NULL ALTER TABLE ecf ADD emisor_json NVARCHAR(MAX) NULL;
-- Fecha y hora de la firma digital (dd-mm-aaaa hh:mm:ss)
IF COL_LENGTH('ecf', 'fecha_firma') IS NULL ALTER TABLE ecf ADD fecha_firma NVARCHAR(25) NULL;
-- Ambiente del proveedor: TesteCF, CerteCF o eCF
IF COL_LENGTH('ecf', 'ambiente') IS NULL ALTER TABLE ecf ADD ambiente NVARCHAR(10) NULL;
GO
-- El proveedor informa el vencimiento de la secuencia después del envío
ALTER TABLE ecf ALTER COLUMN fecha_vencimiento_secuencia DATE NULL;
-- Los mensajes de la DGII pueden ser varios
ALTER TABLE ecf ALTER COLUMN mensaje_dgii NVARCHAR(1000) NULL;
GO
-- Último error al intentar emitir el e-CF de una factura (para reintentos y para el administrador)
IF COL_LENGTH('facturas', 'error_ecf') IS NULL ALTER TABLE facturas ADD error_ecf NVARCHAR(1000) NULL;
GO
