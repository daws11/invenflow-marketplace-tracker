// Shared types for the InvenFlow Marketplace Tracker monorepo.
//
// Currently re-exports the typed mirror of the InvenFlow integration contract
// (§4 of `INTEGRATION_CONTRACT.md`). Both `apps/web` and the worker package
// import from here so request/response shapes stay in lock-step.

export * from './invenflow-api';
