/* =====================================================================
   Monitoreo de secuencias e-NCF con la plataforma e-CF.
   La plataforma no informa los rangos autorizados: el administrador registra el rango
   que aprobó la DGII y el sistema calcula el último número usado con los e-NCF asignados.
   - ambiente NULL: secuencia local del modo simulado.
   - ambiente TesteCF / CerteCF / eCF: rango autorizado registrado para la plataforma.
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO
IF COL_LENGTH('secuencias_ecf', 'ambiente') IS NULL ALTER TABLE secuencias_ecf ADD ambiente NVARCHAR(10) NULL;
-- Fecha de vencimiento que informó la plataforma (FechaVencimientoSecuencia de los e31/e33 emitidos)
IF COL_LENGTH('secuencias_ecf', 'vencimiento_informado') IS NULL ALTER TABLE secuencias_ecf ADD vencimiento_informado DATE NULL;
-- Última sincronización y último aviso enviado (un aviso por día como máximo)
IF COL_LENGTH('secuencias_ecf', 'sincronizado') IS NULL ALTER TABLE secuencias_ecf ADD sincronizado DATETIME2 NULL;
IF COL_LENGTH('secuencias_ecf', 'ultima_alerta') IS NULL ALTER TABLE secuencias_ecf ADD ultima_alerta DATE NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_secuencias_ambiente')
  ALTER TABLE secuencias_ecf ADD CONSTRAINT CK_secuencias_ambiente CHECK (ambiente IS NULL OR ambiente IN (N'TesteCF', N'CerteCF', N'eCF'));
GO
