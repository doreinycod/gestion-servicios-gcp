/* =====================================================================
   Suscripción pendiente de pago: se crea al elegir el plan y se activa
   cuando el pago (PayPal o tarjeta) queda Confirmado.
   Idempotente.
   ===================================================================== */
USE GestionMultiservicios;
GO
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_suscripciones_estado'
            AND definition NOT LIKE '%Pendiente%')
  ALTER TABLE suscripciones DROP CONSTRAINT CK_suscripciones_estado;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_suscripciones_estado')
  ALTER TABLE suscripciones ADD CONSTRAINT CK_suscripciones_estado
    CHECK (estado IN (N'Pendiente', N'Activa', N'Cancelada', N'Suspendida', N'Vencida'));
GO
