-- Se ejecuta solo la primera vez que se crea el volumen.
-- axai: desarrollo (pnpm dev) · axai_test: pnpm test (se reconstruye en cada corrida) · axai_demo: pnpm demo
-- El usuario axai es superusuario del contenedor, así que puede hacer SET ROLE axai_app (RLS aplica igual).
create database axai_test owner axai;
create database axai_demo owner axai;
