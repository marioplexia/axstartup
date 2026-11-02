import { IDS } from '../../src/db/seedData.js';
// Orden FICTICIA con historial completo y datos personales de mentira.
export const AG = IDS.agencies[0][0];
export function fullOrder(n = 'ORD-1001') {
  return {
    agency_id: AG, order_number: n, vin: '3GNAXKEV5NL123456', odometer: 42180, claim_date: '2025-03-10',
    customer_names: ['Juan Pérez López'],
    prea: {
      versions: [
        { submitted_at: '2025-03-10T10:00:00Z', fields: { vin: '3GNAXKEV5NL123456', complaint_text: 'Cliente Juan Pérez López reporta ruido metálico, tel 443 123 4567', work_op: 'OP-MT-031', labor_hours: 3.4 }, text: 'Contacto juan@correo.example.com' },
        { submitted_at: '2025-03-14T09:00:00Z', fields: { vin: '3GNAXKEV5NL123456', complaint_text: 'Ruido metálico en arranque en frío', work_op: 'OP-MT-031', labor_hours: 3.4, cause_code: 'MT-518' }, text: '' },
      ],
      comments: [
        { author_role: 'plant', author: 'Revisor Planta 7', authored_at: '2025-03-12T12:00:00Z', body: 'Rechazada: falta foto del tensor. Contactar a Juan Pérez López.' },
        { author_role: 'advisor', author: 'Lucía Ortega', authored_at: '2025-03-13T08:00:00Z', body: 'Se agrega evidencia.' },
      ],
    },
    transactions: [{ tx_number: 'TX-1', paid_at: '2025-03-20', lines: [
      { concept: 'labor' as const, op_code: 'OP-MT-031', hours: 3.4, rate: 420, amount_paid: 1428 },
      { concept: 'part' as const, part_no: 'PZ-MT-6120', quantity: 1, unit_price: 2140, amount_paid: 2140 },
    ] }],
  };
}
