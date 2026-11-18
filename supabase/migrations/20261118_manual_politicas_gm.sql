-- Manual oficial de políticas de garantías (GM México) por sección, para que los agentes lo consulten y lo citen.
-- El TEXTO del manual es confidencial de GM y se carga directo en la base de datos; no se guarda en el repositorio.
create table if not exists public.manual_politicas (
  id bigserial primary key,
  fuente text not null,
  seccion text not null,
  titulo text not null,
  pagina int,
  texto text not null,
  tsv tsvector generated always as (to_tsvector('spanish', coalesce(seccion,'')||' '||coalesce(titulo,'')||' '||coalesce(texto,''))) stored,
  created_at timestamptz not null default now(),
  unique (fuente, seccion)
);
create index if not exists manual_politicas_tsv on public.manual_politicas using gin (tsv);
alter table public.manual_politicas enable row level security;
drop policy if exists manual_politicas_leer on public.manual_politicas;
create policy manual_politicas_leer on public.manual_politicas for select to authenticated using (true);

-- búsqueda por cualquier palabra (OR con prefijos), ordenada por relevancia y por coincidencia en el título
create or replace function public.buscar_politicas(p_texto text, p_limite int default 5)
returns table (seccion text, titulo text, pagina int, fuente text, texto text, rango real)
language plpgsql stable security invoker set search_path = public as $$
declare
  palabras text[];
  oq tsquery;
begin
  select array_agg(distinct w) into palabras
  from regexp_split_to_table(lower(coalesce(p_texto,'')), '[^a-záéíóúñü0-9]+') w
  where length(w) >= 3 and w not in ('que','para','con','los','las','del','una','por','como','cuando','tengo','necesito','puedo','debo','hay','son','qué','cuántos','cuanto','cuántas','después','antes','sobre','este','esta','lleva');
  if palabras is null then
    return query select m.seccion,m.titulo,m.pagina,m.fuente,m.texto,0::real from manual_politicas m order by m.id limit greatest(1, least(coalesce(p_limite,5),10));
    return;
  end if;
  select string_agg(quote_literal(x)||':*',' | ')::text::tsquery into oq
  from (select to_tsvector('spanish', w)::text as v, w from unnest(palabras) w) s,
       lateral (select (regexp_matches(s.v, '''([^'']+)''','g'))[1] as x) t;
  return query
  select m.seccion, m.titulo, m.pagina, m.fuente, m.texto,
    (ts_rank_cd(m.tsv, oq, 1) * 10
     + coalesce((select count(*) from unnest(palabras) w where lower(m.titulo) like '%'||w||'%'),0) * 0.5)::real as rango
  from manual_politicas m
  where oq is not null and m.tsv @@ oq
  order by rango desc, m.id
  limit greatest(1, least(coalesce(p_limite,5),10));
end $$;
grant execute on function public.buscar_politicas(text,int) to authenticated;
