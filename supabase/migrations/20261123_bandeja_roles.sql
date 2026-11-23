-- Bandeja por roles: solo el asesor de garantías dueño del caso lo envía a GM.
-- El dueño, el director (y el gerente) no envían: piden avance a la agencia y al asesor le llega la alerta al instante.
alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check check (tipo in ('debito','rechazo','boletin','politica','regla','plazo','etapa','avance'));
alter table public.decisiones drop constraint if exists decisiones_decision_check;
alter table public.decisiones add constraint decisiones_decision_check check (decision in ('enviar','corregir','tecnico','nota','avance'));

-- "enviar" solo lo registra el asesor dueño del caso
drop policy if exists "decisiones insert" on public.decisiones;
create policy "decisiones insert" on public.decisiones for insert to authenticated
  with check (user_id = (select auth.uid()) and decision <> 'avance' and exists (select 1 from public.expedientes e where e.id = expediente_id
    and (e.user_id = (select auth.uid()) or public.can_ver(e.user_id))
    and (decision <> 'enviar' or e.user_id = (select auth.uid()))));

-- y solo él puede marcarlo como enviado
create or replace function public.solo_asesor_envia() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if (select auth.uid()) is not null and new.enviado_at is distinct from old.enviado_at and (select auth.uid()) <> old.user_id then
    raise exception 'Solo el asesor de garantías del caso puede enviarlo a GM' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_solo_asesor_envia on public.expedientes;
create trigger trg_solo_asesor_envia before update of enviado_at on public.expedientes for each row execute function public.solo_asesor_envia();

-- pedir avance: queda en la bandeja del caso y le llega como alerta al asesor y a los gerentes de su agencia
create or replace function public.pedir_avance(p_exp uuid, p_msg text) returns uuid
language plpgsql security definer set search_path to '' as $$
declare e record; yo record; d uuid; msg text := left(btrim(coalesce(p_msg, '')), 600);
begin
  select x.id, x.user_id, x.wo, x.folio, p.agency_id into e from public.expedientes x join public.profiles p on p.id = x.user_id where x.id = p_exp;
  if e.id is null or not (e.user_id = (select auth.uid()) or public.can_ver(e.user_id)) then raise exception 'expediente_no_disponible'; end if;
  if msg = '' then msg := '¿Cómo va este caso?'; end if;
  select name, role into yo from public.profiles where id = (select auth.uid());
  insert into public.decisiones (expediente_id, user_id, decision, nota) values (p_exp, (select auth.uid()), 'avance', msg) returning id into d;
  insert into public.alertas (tipo, alcance, user_id, titulo, cuerpo, accion, expediente_id, urgente)
  select 'avance', 'usuario', u.id,
    coalesce(split_part(yo.name, ' ', 1), 'Dirección') || ' pregunta por ' || coalesce(e.wo, e.folio, 'un caso'),
    msg, 'Contesta con una nota en la bandeja para que vea cómo va.', p_exp, msg ~* 'urgent|hoy|ya'
  from public.profiles u
  where u.id <> (select auth.uid()) and (u.id = e.user_id or (u.agency_id = e.agency_id and u.role = 'gerente'));
  return d;
end $$;
revoke all on function public.pedir_avance(uuid, text) from public, anon;
grant execute on function public.pedir_avance(uuid, text) to authenticated;
