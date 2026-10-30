import { createContext, useContext } from 'react';
import type { PropsWithChildren } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { Action, Role, TeamMembership, User } from './types';
interface SessionState {
  user?: User;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<unknown>;
}
const SessionContext = createContext<SessionState | undefined>(undefined);
export function SessionProvider({ children }: PropsWithChildren) {
  const query = useQuery({
    queryKey: ['session'],
    queryFn: ({ signal }) => api<User>('/me', { signal }),
    retry: false,
    refetchOnWindowFocus: true,
  });
  return (
    <SessionContext.Provider
      value={{
        user:
          query.error instanceof ApiError && query.error.status === 401 ? undefined : query.data,
        loading: query.isPending,
        error: query.error instanceof ApiError && query.error.status === 401 ? null : query.error,
        refresh: query.refetch,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('Session provider missing');
  return value;
}
export function hasRole(user: User | undefined, role: Role) {
  return user?.roles.includes(role) ?? false;
}
export function can(user: User | undefined, action: Action, teamId?: string): boolean {
  const caps = user?.capabilities;
  if (!caps) return false;
  if (caps.global?.includes(action)) return true;
  if (teamId) return caps.teams?.[teamId]?.includes(action) ?? false;
  return Object.values(caps.teams ?? {}).some((list) => list.includes(action));
}
export function isStaff(user: User | undefined) {
  return can(user, 'ticket.work');
}
export function roleLabel(role: Role) {
  return role.replace('_', ' ');
}
export function teamChipLabel(team: TeamMembership) {
  return `${team.teamCode} · ${team.level === 'LEAD' ? 'Lead' : 'Member'}`;
}
