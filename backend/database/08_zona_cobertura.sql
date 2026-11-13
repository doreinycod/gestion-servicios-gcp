/* =====================================================================
   Zona de cobertura del prestador: varios sectores separados por coma
   (los nombres de los sectores de Santiago no caben en 100 caracteres).
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO
IF (SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'empleados' AND COLUMN_NAME = 'zona_cobertura') < 500
  ALTER TABLE empleados ALTER COLUMN zona_cobertura NVARCHAR(500) NULL;
GO
