# Genera los PDF e imágenes de ejemplo para probar el entrenamiento del agente (datos ficticios).
# Uso: python3 samples/generar.py
import os
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))

def pdf(nombre, titulo, campos, comentarios=None, extra=None):
    c = canvas.Canvas(os.path.join(OUT, nombre), pagesize=A4)
    W, H = A4; y = H - 50
    c.setFont('Helvetica-Bold', 15); c.drawString(40, y, titulo); y -= 26
    for k, v in campos:
        if k.startswith('#'):
            y -= 6; c.setFont('Helvetica-Bold', 11); c.drawString(40, y, k[1:]); y -= 16; continue
        c.setFont('Helvetica-Bold', 9.5)
        if k: c.drawString(40, y, k + ':')
        c.setFont('Helvetica', 9.5)
        for i, line in enumerate(wrap(v, 78)):
            c.drawString(215, y, line); y -= 13
        y -= 2
        if y < 70: c.showPage(); y = H - 50
    if comentarios:
        y -= 8; c.setFont('Helvetica-Bold', 11); c.drawString(40, y, 'Historial de comentarios'); y -= 18
        for t in comentarios:
            c.setFont('Helvetica', 9.2)
            for line in wrap(t, 105): c.drawString(40, y, line); y -= 12.5
            y -= 5
            if y < 70: c.showPage(); y = H - 50
    c.save()

def wrap(s, n):
    out, cur = [], ''
    for w in s.split():
        if len(cur) + len(w) + 1 > n: out.append(cur); cur = w
        else: cur = (cur + ' ' + w).strip()
    return out + [cur] if cur else out or ['']

def imagen(nombre, titulo, campos, comentarios):
    f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 20)
    b = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 20)
    lines = [(titulo, b)]
    for k, v in campos:
        if k.startswith('#'): lines.append((k[1:], b)); continue
        for i, l in enumerate(wrap(v, 62)): lines.append((((k + ': ') if (i == 0 and k) else '    ') + l, f))
    if comentarios:
        lines.append(('Historial de comentarios', b))
        for t in comentarios:
            for l in wrap(t, 80): lines.append((l, f))
    img = Image.new('RGB', (1500, 60 + 32 * len(lines)), 'white'); d = ImageDraw.Draw(img)
    for i, (t, ft) in enumerate(lines): d.text((40, 30 + 32 * i), t, fill='black', font=ft)
    img.save(os.path.join(OUT, nombre))

# ---------- 1) PREA aceptada: polea tensora, Aveo 2024, 40,120 km ----------
prea_aveo = [
 ('ID de autorización de pre-reparación', 'PREA-48210'), ('Unidad de negocio', 'General Motors de México'), ('Tipo de transacción', 'Transacción Normal de Vehículo'),
 ('BAC', '183147'), ('Reparador', 'FAME MORELIA'), ('Orden de trabajo', 'G-AVEO4021'), ('Fecha de la Orden de trabajo', '14/03/2026'),
 ('Vehículo', 'Chevrolet Aveo 2024'), ('VIN', '3G1TA5CF8RL123456'), ('Cuentakilómetros', '40,120'), ('Marcador de transacción', 'Defecto de Fábrica'),
 ('Queja', 'EM-215 - RUIDO O CHIRRIDO EN EL MOTOR AL ARRANCAR'),
 ('', 'El cliente reporta chirrido proveniente de la banda de accesorios al encender el motor en frío.'),
 ('Causa', 'EM-482 - POLEA TENSORA DE BANDA DESGASTADA'),
 ('', 'Se realizó el diagnóstico y se confirmó juego axial excesivo y ruido en el rodamiento de la polea tensora.'),
 ('Corrección', 'EM-571 - REEMPLAZAR POLEA TENSORA Y BANDA DE ACCESORIOS'),
 ('Operación de trabajo', 'OP-EM-044 - Reemplazar polea tensora de banda de accesorios'), ('Tiempo de trabajo', '1.2'),
 ('Total de piezas', '1,184.00'),
 ('Números de pieza', 'PZ-EM-7710  Polea tensora de banda  1 x 684.00'), ('', 'PZ-EM-7711  Banda de accesorios serpentina  1 x 500.00'),
 ('Total tiempo', '1.2'), ('Tarifa Mano de Obra', '420.00'), ('Total bruto', '1,688.00'), ('Deducible', '0.00'),
 ('Código de autorización', 'AUT-77120'), ('Estado', 'ACEPTADA')]
com_aveo = [
 '12/03/2026 09:14 - Agencia (H. Castañeda): Se solicita autorización para el reemplazo de la polea tensora. Se adjunta el ticket de diagnóstico.',
 '12/03/2026 15:40 - Planta (Garantías GM): RECHAZADA. El código de causa no corresponde a la queja capturada. Falta registrar el kilometraje exacto y la fotografía de la polea desgastada.',
 '13/03/2026 10:05 - Agencia (H. Castañeda): Se corrige el código de causa a EM-482 y se agregan fotografías del componente y el kilometraje 40,120.',
 '13/03/2026 16:22 - Planta (Garantías GM): Se solicita justificar el tiempo de mano de obra; el tiempo estándar de la operación es de 1.2 h.',
 '14/03/2026 08:30 - Agencia (H. Castañeda): Tiempo ajustado a 1.2 h conforme al tabulador.',
 '14/03/2026 11:02 - Planta (Garantías GM): ACEPTADA. Código de autorización AUT-77120.']
pdf('1-PREA-aceptada-Aveo-2024-polea.pdf', 'Ver autorización previa a la reparación', prea_aveo, com_aveo)
imagen('1b-PREA-aceptada-Aveo-2024-polea-captura.png', 'Ver autorización previa a la reparación', prea_aveo, com_aveo)

# ---------- 2) Pago de planta de esa PREA ----------
pdf('2-Pago-planta-Aveo-2024-polea.pdf', 'Detalle de transacción de pago - Garantías', [
 ('Referencia de pago', 'PAG-2026-0328-8821'), ('Fecha de pago', '28/03/2026'), ('Reparador', 'FAME MORELIA (BAC 183147)'),
 ('Orden de trabajo', 'G-AVEO4021'), ('Código de autorización', 'AUT-77120'), ('VIN', '3G1TA5CF8RL123456'),
 ('Operación', 'OP-EM-044 - Reemplazar polea tensora de banda de accesorios'), ('Tiempo pagado', '1.2'), ('Tarifa Mano de Obra', '420.00'),
 ('Mano de obra pagada', '504.00'),
 ('#Piezas pagadas', ''), ('', 'PZ-EM-7710  Polea tensora de banda  1 x 684.00'), ('', 'PZ-EM-7711  Banda de accesorios serpentina  1 x 480.00'),
 ('Total piezas pagado', '1,164.00'), ('Ajustes', 'Ajuste de precio de pieza PZ-EM-7711: -20.00'),
 ('Total pagado', '1,668.00'), ('Estatus de pago', 'PAGADO')])

# ---------- 3) Otra PREA aceptada: sensor de oxígeno, Equinox 2023 ----------
prea_eq = [
 ('ID de autorización de pre-reparación', 'PREA-51377'), ('Unidad de negocio', 'General Motors de México'), ('Reparador', 'FAME MORELIA'),
 ('Orden de trabajo', 'G-EQX7710'), ('Fecha de la Orden de trabajo', '02/04/2026'), ('Vehículo', 'Chevrolet Equinox 2023'), ('VIN', '3GNAXUEV5PL445566'),
 ('Cuentakilómetros', '58,300'), ('Queja', 'EM-120 - LUZ DE MOTOR ENCENDIDA'),
 ('Causa', 'EM-340 - SENSOR DE OXÍGENO FUERA DE RANGO'), ('Corrección', 'EM-440 - REEMPLAZAR SENSOR DE OXÍGENO Y ARNÉS'),
 ('Operación de trabajo', 'OP-EM-007 - Reemplazar sensor de oxígeno banco 1'), ('Tiempo de trabajo', '0.8'), ('Total de piezas', '2,960.00'),
 ('Números de pieza', 'PZ-EM-1180  Sensor de oxígeno B1S1  1 x 2350.00'), ('', 'PZ-EM-1190  Arnés del sensor  1 x 610.00'),
 ('Tarifa Mano de Obra', '420.00'), ('Total bruto', '3,296.00'), ('Código de autorización', 'AUT-80214'), ('Estado', 'ACEPTADA')]
com_eq = [
 '01/04/2026 17:10 - Agencia (L. Ortega): Solicitud de autorización por luz de motor encendida con código P0131.',
 '02/04/2026 09:45 - Planta (Garantías GM): Favor de adjuntar la captura de GDS2 con los códigos de falla antes de autorizar.',
 '02/04/2026 12:20 - Agencia (L. Ortega): Se adjunta la captura de GDS2 con el código P0131 y los datos congelados.',
 '03/04/2026 10:00 - Planta (Garantías GM): ACEPTADA. Código de autorización AUT-80214.']
pdf('3-PREA-aceptada-Equinox-2023-sensor-oxigeno.pdf', 'Ver autorización previa a la reparación', prea_eq, com_eq)
pdf('4-Pago-planta-Equinox-2023-sensor-oxigeno.pdf', 'Detalle de transacción de pago - Garantías', [
 ('Referencia de pago', 'PAG-2026-0418-9034'), ('Fecha de pago', '18/04/2026'), ('Orden de trabajo', 'G-EQX7710'), ('Código de autorización', 'AUT-80214'),
 ('VIN', '3GNAXUEV5PL445566'), ('Operación', 'OP-EM-007 - Reemplazar sensor de oxígeno banco 1'), ('Tiempo pagado', '0.8'), ('Tarifa Mano de Obra', '420.00'),
 ('Mano de obra pagada', '336.00'), ('#Piezas pagadas', ''), ('', 'PZ-EM-1180  Sensor de oxígeno B1S1  1 x 2350.00'), ('', 'PZ-EM-1190  Arnés del sensor  1 x 610.00'),
 ('Total piezas pagado', '2,960.00'), ('Total pagado', '3,296.00'), ('Estatus de pago', 'PAGADO')])

# ---------- 6 y 7) Dos PREAs aceptadas más del mismo caso (con tres, la regla se activa y se reparte a los asesores) ----------
def variante(orden, folio, vin, km, fecha, auth, anio='2024'):
    c = []
    for k, v in prea_aveo:
        v2 = {'G-AVEO4021': orden, 'PREA-48210': folio, '3G1TA5CF8RL123456': vin, '40,120': km, '14/03/2026': fecha, 'AUT-77120': auth, 'Chevrolet Aveo 2024': 'Chevrolet Aveo ' + anio}.get(v, v)
        c.append((k, v2))
    return c
coms2 = ['10/05/2026 09:00 - Agencia (J. Salinas): Solicitud de autorización por chirrido de la banda de accesorios al arrancar.',
         '10/05/2026 14:30 - Planta (Garantías GM): ACEPTADA. Código de autorización AUT-78004.']
pdf('6-PREA-aceptada-Aveo-2024-polea-b.pdf', 'Ver autorización previa a la reparación', variante('G-AVEO4177', 'PREA-49903', '3G1TA5CF2RL777001', '38,900', '10/05/2026', 'AUT-78004'), coms2)
pdf('7-PREA-aceptada-Aveo-2023-polea-c.pdf', 'Ver autorización previa a la reparación', variante('G-AVEO4302', 'PREA-50455', '3G1TA5CF9PL888002', '41,250', '22/06/2026', 'AUT-79310', '2023'),
    ['22/06/2026 08:20 - Agencia (L. Ortega): Se solicita autorización para el reemplazo de polea tensora.', '22/06/2026 16:10 - Planta (Garantías GM): ACEPTADA. Código de autorización AUT-79310.'])

# ---------- 5) PREA que el asesor quiere validar (con los mismos errores del pasado) ----------
pdf('5-PREA-por-validar-Aveo-2024-polea.pdf', 'Autorización previa a la reparación (borrador)', [
 ('Orden de trabajo', 'G-AVEO4388'), ('Fecha de la Orden de trabajo', '28/10/2026'), ('Vehículo', 'Chevrolet Aveo 2024'), ('VIN', '3G1TA5CF1RL654321'),
 ('Queja', 'EM-215 - RUIDO O CHIRRIDO EN EL MOTOR AL ARRANCAR'), ('', 'Cliente reporta chirrido al encender el motor.'),
 ('Causa', 'EM-300 - FALLA GENERAL DE MOTOR'), ('Corrección', 'EM-571 - REEMPLAZAR POLEA TENSORA Y BANDA DE ACCESORIOS'),
 ('Operación de trabajo', 'OP-EM-044 - Reemplazar polea tensora de banda de accesorios'), ('Tiempo de trabajo', '1.8'),
 ('Números de pieza', 'PZ-EM-7710  Polea tensora de banda  1 x 684.00'), ('Tarifa Mano de Obra', '420.00'), ('Total bruto', '1,440.00'), ('Estado', 'POR CAPTURAR')], [])
print('listo:', sorted(f for f in os.listdir(OUT) if f[0].isdigit()))
