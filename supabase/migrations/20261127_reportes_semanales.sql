-- Agente de reportes: cada lunes 8:00 a.m. (centro de México = 14:00 UTC) cada director recibe en su Bandeja
-- el reporte del dinero recuperado (ya cobrado) SOLO de las agencias que dirige.
-- Aplicado en el proyecto con este contenido (más los ajustes de nombres de mes en español y la variable k).
-- · is_dueno()
-- · director_agencias(director_id, agency_id) + directores_grupo() + asignar_director(p_agency, p_director): el dueño asigna.
-- · buzon.para: un mensaje para una sola persona; RLS de buzon: (para is null or para = auth.uid()).
-- · buzon_agente_check incluye 'reportes'.
-- · cobrado_de_agencias(p_agencias, p_desde, p_hasta): detalle por orden (solo para el agente; sin permiso a usuarios).
-- · enviar_reportes_semanales(p_forzar): semana lunes–domingo anterior + acumulado del mes; una vez por director y semana (clave).
-- · cron: 'reportes-semanales-directores' '0 14 * * 1'.
-- Ver definiciones vigentes con pg_get_functiondef.

-- Corrección (PGRST201 al iniciar sesión): director_agencias y buzon.para apuntaban a profiles, y PostgREST tomó
-- director_agencias como tabla puente profiles↔agencies, volviendo ambiguo el embed profiles→agencies(...).
-- Ahora apuntan a auth.users (mismo id que profiles), así solo queda el camino profiles.agency_id → agencies.
alter table public.director_agencias drop constraint if exists director_agencias_director_id_fkey;
alter table public.director_agencias add constraint director_agencias_director_id_fkey foreign key (director_id) references auth.users(id) on delete cascade;
alter table public.buzon drop constraint if exists buzon_para_fkey;
alter table public.buzon add constraint buzon_para_fkey foreign key (para) references auth.users(id) on delete cascade;
notify pgrst, 'reload schema';
