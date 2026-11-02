import type pg from 'pg';
import { IDS, FORM_FIELDS, LABOR_RATE_MXN, STD_OPS, PART_PRICES } from './seedData.js';

/** Idempotente. Debe correr con un rol privilegiado (no axai_app). */
export async function seed(c: pg.Pool | pg.PoolClient | pg.Client): Promise<void> {
  await c.query(`insert into groups(id,name) values ($1,'Grupo FAME (ficticio)') on conflict do nothing`, [IDS.group]);
  await c.query(`insert into brands(id,group_id,name,code) values ($1,$2,'General Motors','GM') on conflict do nothing`, [IDS.brand, IDS.group]);
  for (const [i, [id, name, city]] of IDS.agencies.entries()) {
    await c.query(`insert into agencies(id,group_id,brand_id,name,city) values ($1,$2,$3,$4,$5) on conflict do nothing`, [id, IDS.group, IDS.brand, name, city]);
    await c.query(`insert into users(id,group_id,agency_id,email,display_name,role) values ($1,$2,$3,$4,$5,'advisor') on conflict do nothing`,
      [IDS.advisor(i), IDS.group, id, `asesor${i + 1}@fame.example.test`, `Asesor ${i + 1} ${city}`]);
  }
  await c.query(`insert into users(id,group_id,email,display_name,role) values ($1,$2,'revisor@fame.example.test','Revisor FAME','reviewer') on conflict do nothing`, [IDS.reviewer, IDS.group]);
  await c.query(`insert into users(id,group_id,email,display_name,role) values ($1,$2,'dueno@fame.example.test','Dueño FAME','owner') on conflict do nothing`, [IDS.owner, IDS.group]);

  // Reglas bucle 1 derivadas SOLO del formulario: campo obligatorio. Las demás se aprenden con expedientes.
  for (const [key, label] of FORM_FIELDS) {
    await c.query(
      `insert into rules(group_id,brand_id,rule_key,version,loop,status,kind,title,severity,condition,origin,valid_from)
       values ($1,$2,$3,1,1,'active','required_field',$4,'blocker',$5,'form','2024-01-01') on conflict do nothing`,
      [IDS.group, IDS.brand, `form.required.${key}`, `Campo obligatorio: ${label}`, JSON.stringify({ type: 'required_field', field: key })]);
  }

  // Tabuladores iniciales FICTICIOS (bucle 2). Se afinan con pagos reales vía corte nocturno.
  const tab = (key: string, kind: string, subject: string | null, value: number, unit: string) =>
    c.query(
      `insert into tabulators(group_id,brand_id,tab_key,version,kind,subject,value,unit,status,valid_from,origin)
       values ($1,$2,$3,1,$4,$5,$6,$7,'active','2024-01-01','seed') on conflict do nothing`,
      [IDS.group, IDS.brand, key, kind, subject, value, unit]);
  await tab('labor_rate', 'labor_rate', null, LABOR_RATE_MXN, 'MXN/h');
  await tab('deductible', 'deductible', null, 0, 'MXN');
  for (const [op, h] of STD_OPS) await tab(`std_time:${op}`, 'standard_time', op, h, 'h');
  for (const [p, price] of PART_PRICES) await tab(`part_price:${p}`, 'part_price', p, price, 'MXN');
}
