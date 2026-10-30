Read HANDOFF.md first, especially "Planned next: department rules (approved by owner)", "Known gaps", "Working rules" and "Environment".

Implement the 5 department rules from that section, in this order. Write a failing test first for each, then make it pass:

1. Each team adds only its own asset types: a type→team mapping in Master Control; the Add/Edit asset form offers only the owning team's types; the API rejects others with 422 "This asset type belongs to another team"; Super Admin can override.
2. Admin and Projects can VIEW each other's assets (new team_view_grants table seeded ADM↔PRJ; extend assetScope in apps/api/src/domain-helpers.ts). Editing, assigning and retiring stay with the owning team only. IT stays separate: IT sees only IT, and Admin/Projects never see IT items. Super Admin, Finance and Executive still see everything.
3. Tickets about furniture/facility items always go to Admin, even if Projects owns the item; IT items go to IT. Route by the asset type's "handled by" team in createTicket (apps/api/src/domain-tickets.ts). Non-asset tickets keep the category→team mapping.
4. Team dashboard: GET /dashboard/team for any team member, scoped to their teams plus shared-view teams. Show counts by status, value, items needing attention, and open tickets. Reuse the queries in apps/api/src/executive-dashboard.ts. Show it on the team member's home page.
5. Also do "Planned next: make team access easy to give" (Teams section in People & access, Manage members link, My assets card for employees).

Rules:
- New migrations continue from 026. Apply them to both databases: `npm run db:migrate -w @iac/api -- --test` and `npm run db:migrate`. Update infra/runtime-grants.sql for new tables (least privilege, never DELETE on users).
- Do not commit or create branches.
- At the end run: npm run lint, npm run typecheck, npm test, npm run test:integration, npm run build. Only the 3 known data-transfers failures are allowed.
- Update HANDOFF.md with what you did and anything left over.
