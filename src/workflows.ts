/**
 * Stable workflow ArrowSchema facade for qianji-server consumers.
 *
 * Browser and server consumers should import workflow read-model contracts from
 * `pi-wendao/workflows` instead of duplicating JSON DTOs. Fixture catalog
 * helpers are exposed only for test/dev harnesses that intentionally exercise
 * the checked-in BPMN fixtures.
 */
export {
  findFixtureQianjiWorkflow,
  fixtureQianjiWorkflowCatalogArrowTable,
  listFixtureQianjiWorkflowCatalog,
  qianjiWorkflowCatalogRowsFromFlowhubRegistry,
  type FixtureQianjiWorkflowCatalogOptions,
  type FlowhubQianjiWorkflowCatalogOptions,
} from "./workflows/catalog.js";
export {
  QIANJI_WORKFLOW_CATALOG_SCHEMA,
  QIANJI_WORKFLOW_CATALOG_TABLE,
  qianjiWorkflowCatalogRowsFromTable,
  qianjiWorkflowCatalogTable,
  type QianjiWorkflowCatalogRowDto,
} from "./workflows/schema.js";
