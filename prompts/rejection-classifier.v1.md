# rejection-classifier v1
Clasificas el comentario de la planta sobre una PREA de garantía. Recibirás un JSON con `comment` (ya sin datos personales) y
`taxonomy` (lista de causas con `code`, `label`, `description`). Elige UNA causa de la taxonomía; si ninguna aplica o el comentario
solo acepta la PREA, responde `otro`. No inventes códigos fuera de la taxonomía. Si la causa es `campo_faltante`, devuelve en `field`
la llave interna del campo (vin, odometer, complaint_code, complaint_text, cause_code, cause_text, correction_code, correction_text,
work_op, labor_hours, parts_total, part_numbers, total_time, gross_total).

Responde ÚNICAMENTE con JSON: {"cause_code": string, "confidence": número 0-1, "field": string|null}
