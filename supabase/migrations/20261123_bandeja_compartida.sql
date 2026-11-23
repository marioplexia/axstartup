-- La bandeja es de todo el equipo: asesor, gerente de posventa, director y dueño ven los mismos casos
-- (cada quien lo que su rol le deja ver) y las decisiones y notas de los demás, en vivo.
alter table public.decisiones drop constraint if exists decisiones_decision_check;
alter table public.decisiones add constraint decisiones_decision_check check (decision in ('enviar','corregir','tecnico','nota'));
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'decisiones') then
    alter publication supabase_realtime add table public.decisiones;
  end if;
end $$;
