import { useRef } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from './api';
import type { RequestOptions } from './api';
import type { Page } from './types';
export function usePages<T>(
  path: string,
  filters: Record<string, string | undefined> = {},
  enabled = true,
  refetchInterval: number | false = false,
) {
  return useInfiniteQuery({
    queryKey: [path, filters],
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<Page<T>>(
        path + queryString({ ...filters, cursor: pageParam || undefined, limit: '25' }),
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
export function useAction<T = unknown>() {
  const queryClient = useQueryClient();
  const keys = useRef(new Map<string, string>());
  return useMutation({
    mutationFn: async ({
      path,
      body,
      method = 'POST',
      version,
      idempotent = false,
    }: {
      path: string;
      body?: unknown;
      method?: RequestOptions['method'];
      version?: number;
      idempotent?: boolean;
    }) => {
      const signature = JSON.stringify([path, method, body, version]);
      let key = keys.current.get(signature);
      if (idempotent && !key) {
        key = crypto.randomUUID();
        keys.current.set(signature, key);
      }
      const result = await api<T>(path, {
        method,
        body,
        version,
        idempotencyKey: idempotent ? key : undefined,
      });
      keys.current.delete(signature);
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
