export type LmsEnrollmentKind = 'course' | 'webinar'

export interface LmsEnrollment {
  id: string
  kind: LmsEnrollmentKind
  title: string
  status: string
  enrolledAt: string | null
}

export interface LmsEnrollmentsResult {
  enrollments: LmsEnrollment[]
}

export type LmsErrorCode =
  | 'misconfigured'
  | 'unauthorized'
  | 'unreachable'
  | 'timeout'
  | 'bad_response'
  | 'invalid_phone'
