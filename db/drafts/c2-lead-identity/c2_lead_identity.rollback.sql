-- DRAFT rollback of c2_lead_identity.sql. Nothing else references these objects.
DROP VIEW IF EXISTS lead_investigations;
DROP TABLE IF EXISTS hypothesis_leads;
DROP FUNCTION IF EXISTS hypothesis_leads_guard();
