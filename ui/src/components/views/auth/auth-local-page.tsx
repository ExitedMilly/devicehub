import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon20MailOutline, Icon20KeyOutline } from '@vkontakte/icons'
import { Button, Div, FormItem, FormLayoutGroup, FormStatus, Group, Input, Panel, Spacing, View } from '@vkontakte/vkui'

import { EmailInput } from '@/components/lib/email-input'
import { DynamicLogo } from '@/components/lib/dynamic-logo'
import { ConditionalRender } from '@/components/lib/conditional-render'

import { authStore } from '@/store/auth-store'
import { useLocalAuth } from '@/lib/hooks/use-local-auth.hook'
import { useGetAuthContact } from '@/lib/hooks/use-get-auth-contact.hook'

import styles from './auth-page.module.css'

import type { ChangeEvent, FormEvent } from 'react'

export const AuthLocalPage = () => {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [formError, setFormError] = useState('')
  const { data: authData, error: authError, mutate: auth, isSuccess } = useLocalAuth()
  const { data: authContact } = useGetAuthContact()

  const onFormSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    auth({ email, password })
  }

  const onEmailChange = (value: string) => {
    setFormError('')

    setEmail(value)
  }

  const onPasswordChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPasswordError('')
    setFormError('')

    setPassword(event.target.value)
  }

  useEffect(() => {
    if (isSuccess) {
      authStore.login(authData.jwt)

      // NOTE: If the origins differ, localStorage will be isolated, so we need to transfer the token explicitly
      const queryParams = window.location.origin === new URL(authData.redirect).origin ? '' : `?jwt=${authData.jwt}`

      window.location.assign(`${authData.redirect}${queryParams}`)
    }
  }, [authData])

  useEffect(() => {
    if (authError?.response?.data.error === 'ValidationError') {
      for (const item of authError.response.data.validationErrors) {
        if (item.param === 'email') {
          setEmailError(item.msg)
        }

        if (item.param === 'password') {
          setPasswordError(item.msg)
        }
      }

      return
    }

    if (authError?.response?.data.error === 'InvalidCredentialsError') {
      setFormError('Incorrect login details')

      return
    }

    if (authError?.response?.data.error) {
      setFormError('We do not recognize you. Please check your spelling and try again or use another login option')
    }
  }, [authError])

  return (
    <View activePanel='main'>
      <Panel id='main' centered>
        <Group className={styles.authPage} separator='hide'>
          <div>
            <form autoComplete='on' className={styles.form} onSubmit={onFormSubmit}>
              <DynamicLogo className={styles.logo} height={55} width={225} />
              <FormLayoutGroup>
                <FormItem bottom={emailError} status={emailError ? 'error' : undefined} top={t('Email')}>
                  <EmailInput
                    before={<Icon20MailOutline />}
                    placeholder='Please enter your email'
                    value={email}
                    onChange={onEmailChange}
                    onError={(error) => setEmailError(error)}
                  />
                </FormItem>
                <FormItem bottom={passwordError} status={passwordError ? 'error' : undefined} top={t('Password')}>
                  <Input
                    autoComplete='current-password'
                    before={<Icon20KeyOutline />}
                    name='password'
                    placeholder={t('Please enter your password')}
                    type='password'
                    value={password}
                    onChange={onPasswordChange}
                  />
                </FormItem>
                <ConditionalRender conditions={[!!formError]}>
                  <Div>
                    <FormStatus mode='error'>{formError}</FormStatus>
                  </Div>
                </ConditionalRender>
                <Spacing size='xl' />
                <FormItem>
                  <Button
                    disabled={!email || !password || !!emailError || !!passwordError || !!formError}
                    id='loginButton'
                    size='l'
                    type='submit'
                    stretched
                  >
                    {t('Log In')}
                  </Button>
                </FormItem>
              </FormLayoutGroup>
              <ConditionalRender conditions={[!!authContact, authContact != 'example.com']}>
                <Button className={styles.contactButton} href={authContact} id='contactButton' mode='link'>
                  {t('Contact Support')}
                </Button>
              </ConditionalRender>
            </form>
          </div>
        </Group>
      </Panel>
    </View>
  )
}
