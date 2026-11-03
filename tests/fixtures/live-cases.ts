/**
 * 5 casos FICTICIOS para comparar el agente simulado contra el real. Los textos llevan datos personales inventados a propósito:
 * el flujo los redacta y sella antes de tocar el modelo. Nada aquí es de una persona o PREA reales.
 * `expect`: lo que un revisor humano esperaría (referencia aparte de la comparación mock vs real).
 */
export interface LiveCase {
  id: string; title: string;
  fields: Record<string, string | number>;
  customer_names: string[];
  evidence: Array<{ kind: string; filename: string; text: string }>;
  required_kinds: string[];
  plant_comment: string;
  expect: { cause_code: string; field?: string; missing: string[] };
}

export const LIVE_CASES: LiveCase[] = [
  {
    id: 'L1', title: 'Completa y aceptada',
    fields: { vin: '3GNAXKEV5NL100001', odometer: 42180, work_op: 'OP-MT-031', labor_hours: 3.4, part_numbers: 'PZ-MT-6120 x1', customer_name: 'Roberto Salcedo Meza' },
    customer_names: ['Roberto Salcedo Meza'],
    evidence: [
      { kind: 'orden_firmada', filename: 'orden.pdf', text: 'Orden de reparación firmada. Cliente Roberto Salcedo Meza, tel 443 555 0192. OP-MT-031 PZ-MT-6120' },
      { kind: 'foto_tablero', filename: 'tablero.jpg', text: 'Foto de tablero 42,180 km' },
    ],
    required_kinds: ['orden_reparacion', 'foto'],
    plant_comment: 'PREA aceptada sin observaciones. Pago en próxima liquidación. Saludos, Marcela Quiroz',
    expect: { cause_code: 'otro', missing: [] },
  },
  {
    id: 'L2', title: 'Falta diagnóstico de escáner',
    fields: { vin: '3GNAXKEV5NL100002', odometer: 51200, work_op: 'OP-EM-007', labor_hours: 0.8, part_numbers: 'PZ-MT-9001 x1' },
    customer_names: [],
    evidence: [{ kind: 'foto_pieza', filename: 'pieza.jpg', text: 'Foto de la pieza dañada' }],
    required_kinds: ['diagnostico', 'foto'],
    plant_comment: 'Se rechaza: falta el diagnóstico de escáner con DTC. Adjuntar reporte y reenviar. Atte. Luis Hernández',
    expect: { cause_code: 'falta_diagnostico', missing: ['diagnostico'] },
  },
  {
    id: 'L3', title: 'Campo de cuentakilómetros vacío',
    fields: { vin: '3GNAXKEV5NL100003', odometer: '', work_op: 'OP-MT-022', labor_hours: 2.1, part_numbers: 'PZ-MT-6121 x2' },
    customer_names: [],
    evidence: [{ kind: 'orden_firmada', filename: 'orden.pdf', text: 'Orden firmada OP-MT-022 PZ-MT-6121' }],
    required_kinds: ['orden_reparacion'],
    plant_comment: 'Rechazada. El campo cuentakilómetros está vacío, favor de capturarlo.',
    expect: { cause_code: 'campo_faltante', field: 'odometer', missing: [] },
  },
  {
    id: 'L4', title: 'Comentario ambiguo con varios faltantes y datos personales',
    fields: { vin: '3GNAXKEV5NL100004', odometer: 33400, work_op: 'OP-MT-031', labor_hours: 3.4, part_numbers: 'PZ-MT-6120 x1' },
    customer_names: ['Ana Paola Ruiz Cárdenas'],
    evidence: [{ kind: 'orden_firmada', filename: 'orden.pdf', text: 'Titular Ana Paola Ruiz Cárdenas, RFC RUCA900515AB3, domicilio Calle Hidalgo #45, Col. Centro, CP 58000. OP-MT-031' }],
    required_kinds: ['orden_reparacion', 'foto', 'factura'],
    plant_comment: 'Hablé con la clienta Ana Paola Ruiz al 443 111 2233 y comenta que no le dieron factura. También no vemos fotos de la falla; ver con el asesor.',
    expect: { cause_code: 'falta_factura', missing: ['foto', 'factura'] },
  },
  {
    id: 'L5', title: 'Operación en evidencia distinta a la del borrador',
    fields: { vin: '3GNAXKEV5NL100005', odometer: 60310, work_op: 'OP-MT-031', labor_hours: 3.4, part_numbers: 'PZ-MT-6120 x1' },
    customer_names: [],
    evidence: [{ kind: 'orden_firmada', filename: 'orden.pdf', text: 'Orden de reparación. Operación realizada OP-TR-014, pieza PZ-MT-6120' }],
    required_kinds: ['orden_reparacion'],
    plant_comment: 'La operación de la orden no corresponde con la capturada en la PREA; códigos no coinciden.',
    expect: { cause_code: 'codigos_inconsistentes', missing: [] },
  },
];
