import { createContext, useContext } from 'react';
import type { PropsWithChildren } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { User, Role } from './types';
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
export function isStaff(user: User | undefined) {
  return hasRole(user, 'ADMIN') || hasRole(user, 'IT_ADMIN');
}
