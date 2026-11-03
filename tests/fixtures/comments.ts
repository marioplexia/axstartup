/**
 * Comentarios FICTICIOS que imitan el tono de los hilos reales entre planta y asesor.
 * Nada de esto es de personas reales: nombres, teléfonos, RFC, CURP, placas y domicilios son inventados.
 * `pii`: cadenas que NO deben sobrevivir. `keep`: cadenas que SÍ deben conservarse (códigos, piezas, importes).
 */
export interface CommentCase { name: string; text: string; names?: string[]; pii: string[]; keep: string[] }

export const COMMENTS: CommentCase[] = [
  {
    name: 'planta pide diagnóstico y cita contacto',
    text: 'Se rechaza por falta de diagnóstico de escáner. Favor de adjuntar DTC P0300 y foto de tablero. Cualquier duda con el cliente Roberto Salcedo Meza al cel 443 555 0192 o roberto.salcedo@correo.example.com. Saludos, Marcela Quiroz',
    pii: ['Roberto', 'Salcedo', '443 555 0192', 'roberto.salcedo@correo', 'Marcela', 'Quiroz'],
    keep: ['P0300', 'diagnóstico de escáner', 'foto de tablero'],
  },
  {
    name: 'asesor responde con datos del cliente y vehículo',
    text: 'Buen día, adjunto orden firmada. Cliente: LUIS ENRIQUE VARGAS TORRES, RFC VATL850312KB7, placas MXA-482-C, VIN 3GNAXKEV5NL123456, 42,180 km. Tel. (44) 3123-9876. Atte. Karen Duarte',
    pii: ['LUIS', 'VARGAS', 'VATL850312KB7', 'MXA-482-C', '3GNAXKEV5NL123456', '123-9876', 'Karen', 'Duarte'],
    keep: ['42,180 km', 'orden firmada'],
  },
  {
    name: 'domicilio completo en observaciones',
    text: 'Unidad se entrega en domicilio del cliente: Calle Benito Juárez #123 Int. 4, Col. Centro, C.P. 58000, Morelia. Reparación OP-MT-031 con pieza PZ-MT-6120 por $12,345.50',
    pii: ['Benito', 'Juárez', '123', 'Centro', '58000'],
    keep: ['OP-MT-031', 'PZ-MT-6120', '$12,345.50', 'Morelia'],
  },
  {
    name: 'avenida con número y colonia abreviada',
    text: 'Ubicación Av. Universidad 1500, Fracc. Los Pinos CP 60600 Uruapan. Contactar a la Sra. Guadalupe Hernández',
    pii: ['Universidad 1500', 'Los Pinos', '60600', 'Guadalupe', 'Hernández'],
    keep: ['Uruapan'],
  },
  {
    name: 'documentos de identidad',
    text: 'Titular Ana Paola Ruiz Cárdenas CURP RUCA900515MMNZRN08, clave de elector RZCRAN90051516M600, INE CIC 123456789012',
    pii: ['Ana Paola', 'RUCA900515MMNZRN08', 'RZCRAN90051516M600', '123456789012'],
    keep: [],
  },
  {
    name: 'teléfonos en formatos variados',
    text: 'Llamar al +52 1 443 111 2233, o al 044 55 4321 8765 o al 4432223344. Oficina tel 321 4567. WhatsApp: 55-9988-7766',
    pii: ['443 111 2233', '55 4321 8765', '4432223344', '321 4567', '9988-7766'],
    keep: [],
  },
  {
    name: 'sin datos personales: no debe tocarse',
    text: 'Se rechaza: horas de mano de obra exceden tabulador OP-TR-210 (3.4 hrs vs 2.1). Pieza PZ-TR-0042 x2 a $1,840.00. Folio 2025-0099, 42180 km, DTC P0171.',
    pii: [],
    keep: ['OP-TR-210', '3.4 hrs vs 2.1', 'PZ-TR-0042 x2', '$1,840.00', 'Folio 2025-0099', '42180 km', 'P0171'],
  },
  {
    name: 'conocido sin disparador',
    text: 'Hablé con Lucía Ortega y confirmó la falla; el vehículo placas 123-ABC sigue en taller',
    names: ['Lucía Ortega'],
    pii: ['Lucía', 'Ortega', '123-ABC'],
    keep: ['confirmó la falla'],
  },
];
