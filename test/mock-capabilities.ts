// Mocked /me payloads for browser tests: the web app gates on capabilities, not role names.
export const superAdminCapabilities = {
  global: [
    'asset.view_all',
    'asset.view_private',
    'asset.create',
    'asset.edit',
    'asset.custody',
    'asset.retire',
    'asset.import',
    'asset.label',
    'asset.photo',
    'asset.finance_edit',
    'asset.change_team',
    'team.manage_members',
    'ticket.work',
    'announcement.send',
    'report.view',
    'system.admin',
  ],
  teams: {},
};
export const superAdmin = {
  roles: ['SUPER_ADMIN', 'EMPLOYEE'],
  teams: [],
  capabilities: superAdminCapabilities,
};
