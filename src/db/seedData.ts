// Datos FICTICIOS. Los campos del formulario provienen del prototipo (gmFields); el resto es de ejemplo.
export const IDS = {
  group: '00000000-0000-4000-8000-000000000001',
  brand: '00000000-0000-4000-8000-000000000010',
  agencies: [
    ['00000000-0000-4000-8000-000000000101', 'FAME Morelia', 'Morelia'],
    ['00000000-0000-4000-8000-000000000102', 'FAME Uruapan', 'Uruapan'],
    ['00000000-0000-4000-8000-000000000103', 'FAME Apatzingán', 'Apatzingán'],
    ['00000000-0000-4000-8000-000000000104', 'FAME Zamora', 'Zamora'],
    ['00000000-0000-4000-8000-000000000105', 'FAME Lázaro Cárdenas', 'Lázaro Cárdenas'],
  ] as const,
  reviewer: '00000000-0000-4000-8000-000000000201',
  owner: '00000000-0000-4000-8000-000000000202',
  advisor: (i: number) => `00000000-0000-4000-8000-00000000030${i + 1}`,
};

/** Campos del formulario GM (fuente: prototipo, 14 campos). key = nombre interno. */
export const FORM_FIELDS: ReadonlyArray<[key: string, label: string]> = [
  ['vin', 'VIN'], ['odometer', 'Cuentakilómetros'],
  ['complaint_code', 'Queja (código)'], ['complaint_text', 'Queja (descripción)'],
  ['cause_code', 'Causa (código)'], ['cause_text', 'Causa (descripción)'],
  ['correction_code', 'Corrección (código)'], ['correction_text', 'Corrección (descripción)'],
  ['work_op', 'Operación de trabajo'], ['labor_hours', 'Tiempo de trabajo'],
  ['parts_total', 'Total de piezas'], ['part_numbers', 'Números de pieza'],
  ['total_time', 'Total tiempo'], ['gross_total', 'Total bruto'],
];

export const LABOR_RATE_MXN = 420; // supuesto ficticio (el prototipo traía 420 y 520)

export const STD_OPS: ReadonlyArray<[op: string, hours: number]> = [
  ['OP-MT-031', 3.4], ['OP-TR-014', 3.2], ['OP-EM-007', 0.8],
  ['OP-MT-022', 2.1], ['OP-EL-003', 1.5], ['OP-FR-011', 1.9], ['OP-DG-001', 1.0],
];

export const PART_PRICES: ReadonlyArray<[part: string, price: number]> = [
  ['PZ-MT-6120', 2140], ['PZ-MT-6121', 860], ['PZ-MT-9001', 150],
  ['PZ-TR-2201', 1840], ['PZ-TR-9005', 170], ['PZ-EM-1180', 2350], ['PZ-EM-1190', 610],
  ['PZ-MT-3310', 780], ['PZ-MT-3311', 190], ['PZ-EL-4402', 6900],
  ['PZ-FR-5501', 1120], ['PZ-FR-5502', 980], ['PZ-GN-0001', 950],
];
