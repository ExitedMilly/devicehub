import { useMutation } from '@tanstack/react-query'

import { localAuth } from '@/api/auth'

import type { AxiosError } from 'axios'
import type { AuthResponse, LocalAuthArgs } from '@/api/auth/types'
import type { UseMutationResult } from '@tanstack/react-query'
import type { AuthErrorResponse } from '@/types/auth-error-response.type'

export const useLocalAuth = (): UseMutationResult<AuthResponse, AxiosError<AuthErrorResponse>, LocalAuthArgs> =>
  useMutation({
    mutationFn: (data) => localAuth(data),
  })
