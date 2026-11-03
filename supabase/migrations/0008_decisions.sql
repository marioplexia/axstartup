-- 0008_decisions: nota de la decisión humana
alter table rules add column decision_note text;
alter table tabulators add column decision_note text;
