/* =====================================================================
   Asistente IA: varias recomendaciones por respuesta.
   - ia_sugerencias.id_mensaje: la respuesta del asistente a la que pertenece cada servicio sugerido.
   - ia_mensajes.prestadores_sugeridos: ids de los prestadores recomendados (en orden, separados por coma).
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO
IF COL_LENGTH('ia_sugerencias', 'id_mensaje') IS NULL
  ALTER TABLE ia_sugerencias ADD id_mensaje INT NULL CONSTRAINT FK_ia_sugerencias_mensaje REFERENCES ia_mensajes (id_mensaje);
IF COL_LENGTH('ia_mensajes', 'prestadores_sugeridos') IS NULL
  ALTER TABLE ia_mensajes ADD prestadores_sugeridos NVARCHAR(100) NULL;
GO
