-- DRAFT rollback of c3_dependency_records.sql. Nothing else references these objects.
DROP TABLE IF EXISTS snapshot_dependencies;
DROP FUNCTION IF EXISTS snapshot_dependencies_guard();
DROP TABLE IF EXISTS package_snapshot_files;
DROP TABLE IF EXISTS package_snapshots;
