-- Exact rollback of the option-D draft (throwaway databases only).
DROP TABLE worker_api_requests;
DROP TABLE worker_capability_tokens;
DROP FUNCTION worker_capability_tokens_guard();
