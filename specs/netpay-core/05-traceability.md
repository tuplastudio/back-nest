# 05 — Matriz de trazabilidad

| REQ | Prioridad | THR | TASK | Test | Estado |
|---|---|---|---|---|---|
| BN-REQ-EVT-001 | P0 | THR-003 | BN-TASK-001 | unit url-guard.spec.ts + integración contra un servicio Cloud Run real en staging | HECHO |
| BN-REQ-EVT-002 | P0 | THR-003 | BN-TASK-002 | unit outbound-dispatcher.spec.ts | HECHO |
| BN-REQ-EVT-003 | P0 | THR-004 | BN-TASK-003 | unit config + e2e health | HECHO |
| BN-REQ-EVT-003 | P0 | THR-004 | BN-TASK-055 | netpay-certification.mjs + checklist | PENDIENTE |
| BN-REQ-EVT-004 | P0 | THR-008 | BN-TASK-004 | integración e2e outbox.e2e-spec.ts | HECHO |
| BN-REQ-EVT-005 | P0 | THR-008 | BN-TASK-004 | integración e2e outbox.e2e-spec.ts | HECHO |
| BN-REQ-EVT-006 | P1 | THR-008 | BN-TASK-004 | integración e2e outbox.e2e-spec.ts | HECHO |
| BN-REQ-EVT-007 | P1 | — | BN-TASK-005 | unit | HECHO |
| BN-REQ-EVT-008 | P1 | THR-025 | BN-TASK-006 | unit con reloj simulado | HECHO |
| BN-REQ-EVT-009 | P1 | — | BN-TASK-007 | unit | HECHO |
| BN-REQ-EVT-010 | P2 | THR-021 | BN-TASK-008 | unit | HECHO |
| BN-REQ-EVT-011 | P1 | — | BN-TASK-009 | contract test + CI | HECHO |
| BN-REQ-IDM-001 | P0 | THR-005 | BN-TASK-010 | e2e idempotency.e2e-spec.ts | HECHO |
| BN-REQ-IDM-002 | P0 | THR-006 | BN-TASK-010 | e2e idempotency.e2e-spec.ts | HECHO |
| BN-REQ-IDM-003 | P0 | THR-005 | BN-TASK-010 | e2e idempotency.e2e-spec.ts | HECHO |
| BN-REQ-IDM-004 | P0 | THR-005 | BN-TASK-011 | integración con fallo inyectado | HECHO |
| BN-REQ-IDM-005 | P1 | THR-015 | BN-TASK-012 | unit netpay-webhook.spec.ts | HECHO |
| BN-REQ-REC-001 | P0 | THR-007 | BN-TASK-016 | integración test/reconciliation.int-spec.ts + e2e | REQUIERE APROBACIÓN |
| BN-REQ-REC-002 | P0 | THR-010 | BN-TASK-016 | integración test/reconciliation.int-spec.ts + e2e | REQUIERE APROBACIÓN |
| BN-REQ-REC-003 | P1 | THR-007 | BN-TASK-016 | integración test/reconciliation.int-spec.ts + e2e | REQUIERE APROBACIÓN |
| BN-REQ-REC-004 | P0 | THR-007 | BN-TASK-016 | integración test/reconciliation.int-spec.ts + e2e | REQUIERE APROBACIÓN |
| BN-REQ-REC-005 | P1 | — | BN-TASK-017 | e2e | HECHO |
| BN-REQ-REC-006 | P1 | — | BN-TASK-017 | e2e | HECHO |
| BN-REQ-PAY-001 | P0 | THR-009 | BN-TASK-015 | e2e | HECHO |
| BN-REQ-PAY-002 | P0 | THR-010 | BN-TASK-015 | e2e | HECHO |
| BN-REQ-PAY-002 | P0 | THR-010 | BN-TASK-055 | netpay-certification.mjs + checklist | PENDIENTE |
| BN-REQ-PAY-003 | P0 | THR-006 | BN-TASK-014 | integración | HECHO |
| BN-REQ-PAY-004 | P1 | THR-024 | BN-TASK-018 | e2e | HECHO |
| BN-REQ-PAY-005 | P1 | — | BN-TASK-019 | unit | HECHO |
| BN-REQ-PAY-006 | P1 | — | BN-TASK-020 | unit con tabla de códigos | HECHO |
| BN-REQ-PAY-007 | P1 | THR-023 | BN-TASK-021 | unit | HECHO |
| BN-REQ-PAY-008 | P2 | THR-026 | BN-TASK-022 | unit | HECHO |
| BN-REQ-PAY-009 | P0 | THR-014 | BN-TASK-023 | unit con fixture | HECHO |
| BN-REQ-PAY-010 | P2 | — | BN-TASK-053 | unit | HECHO |
| BN-REQ-PAY-011 | P0 | THR-005 | BN-TASK-013 | unit | HECHO |
| BN-REQ-PAY-012 | P2 | — | BN-TASK-053 | unit | HECHO |
| BN-REQ-PAY-013 | P2 | — | BN-TASK-054 | — | PENDIENTE |
| BN-REQ-CFG-001 | P1 | THR-016 | BN-TASK-025 | integración sandbox | HECHO |
| BN-REQ-CFG-002 | P0 | THR-016 | BN-TASK-024 | e2e | HECHO |
| BN-REQ-CFG-003 | P1 | THR-016 | BN-TASK-024 | e2e | HECHO |
| BN-REQ-CFG-004 | P0 | THR-017 | BN-TASK-026 | unit + smoke staging | HECHO |
| BN-REQ-CFG-005 | P0 | THR-017 | BN-TASK-027 | script de verificación (curl + jq) | PENDIENTE |
| BN-REQ-CFG-005 | P0 | THR-017 | BN-TASK-055 | netpay-certification.mjs + checklist | PENDIENTE |
| BN-REQ-CFG-006 | P1 | — | BN-TASK-028 | unit + lint | HECHO |
| BN-REQ-SEC-001 | P0 | THR-001 | BN-TASK-029 | e2e + unit rbac-audit | HECHO |
| BN-REQ-SEC-002 | P0 | THR-002 | BN-TASK-031 | e2e | HECHO |
| BN-REQ-SEC-003 | P0 | THR-027 | BN-TASK-031 | e2e | HECHO |
| BN-REQ-SEC-004 | P1 | THR-018 | BN-TASK-032 | e2e | REQUIERE APROBACIÓN |
| BN-REQ-SEC-005 | P1 | THR-015 | BN-TASK-033 | unit | HECHO |
| BN-REQ-SEC-006 | P1 | THR-019 | BN-TASK-034 | e2e | HECHO |
| BN-REQ-SEC-007 | P1 | THR-020 | BN-TASK-035 | unit + job en staging | REQUIERE APROBACIÓN |
| BN-REQ-SEC-008 | P1 | — | BN-TASK-034 | e2e | HECHO |
| BN-REQ-SEC-009 | P2 | THR-028 | BN-TASK-037 | e2e | HECHO |
| BN-REQ-SEC-010 | P1 | — | BN-TASK-038 | e2e CORS | HECHO |
| BN-REQ-SEC-011 | P2 | — | BN-TASK-039 | test de headers | HECHO |
| BN-REQ-SEC-012 | P2 | THR-030 | BN-TASK-040 | integración | HECHO |
| BN-REQ-OPS-001 | P0 | THR-011 | BN-TASK-041 | verificación gh api + workflow de prueba | REQUIERE APROBACIÓN |
| BN-REQ-OPS-002 | P0 | THR-012 | BN-TASK-042 | integración | HECHO |
| BN-REQ-OPS-003 | P0 | THR-013 | BN-TASK-043 | gcloud monitoring + simulacro | REQUIERE APROBACIÓN |
| BN-REQ-OPS-004 | P1 | THR-013 | BN-TASK-036 | unit | HECHO |
| BN-REQ-OPS-005 | P1 | THR-013 | BN-TASK-044 | inspección | REQUIERE APROBACIÓN |
| BN-REQ-OPS-006 | P1 | THR-022 | BN-TASK-045 | ensayo en staging | REQUIERE APROBACIÓN |
| BN-REQ-OPS-007 | P1 | — | BN-TASK-046 | job programado | HECHO |
| BN-REQ-OPS-008 | P2 | THR-029 | BN-TASK-047 | CI | REQUIERE APROBACIÓN |
| BN-REQ-OPS-009 | P1 | — | BN-TASK-048 | CI | HECHO |
| BN-REQ-OPS-010 | P2 | — | BN-TASK-037 | e2e | HECHO |
| BN-REQ-OPS-011 | P1 | THR-021 | BN-TASK-008 | unit | HECHO |
| BN-REQ-OPS-011 | P1 | THR-021 | BN-TASK-030 | e2e | HECHO |
| BN-REQ-OPS-012 | P2 | THR-018 | BN-TASK-049 | prueba de carga en staging | PENDIENTE |
| BN-REQ-API-001 | P1 | — | BN-TASK-009 | contract test + CI | HECHO |
| BN-REQ-API-002 | P1 | — | BN-TASK-013 | unit | HECHO |
| BN-REQ-API-002 | P1 | — | BN-TASK-050 | e2e | HECHO |
| BN-REQ-API-003 | P1 | — | BN-TASK-050 | e2e | HECHO |
| BN-REQ-API-004 | P2 | — | BN-TASK-025 | integración sandbox | HECHO |
| BN-REQ-DOC-001 | P2 | — | BN-TASK-051 | script docs-lint | HECHO |
| BN-REQ-DOC-002 | P2 | — | BN-TASK-051 | script docs-lint | HECHO |
| BN-REQ-DOC-003 | P2 | — | BN-TASK-051 | script docs-lint | HECHO |
| BN-REQ-DOC-004 | P2 | — | BN-TASK-039 | test de headers | HECHO |
| BN-REQ-DOC-004 | P2 | — | BN-TASK-051 | script docs-lint | HECHO |
| BN-REQ-DOC-005 | P1 | — | BN-TASK-052 | revisión | HECHO |

Requisitos sin task: ninguno.
