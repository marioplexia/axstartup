-- 0009: el rol que se conecta (migraciones/app) debe poder hacer SET ROLE axai_app para que RLS aplique en cada transacción
do $$ begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant axai_app to %I', current_user);
  end if;
end $$;
