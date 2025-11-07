import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(req: NextRequest) {
  const isAuth = req.cookies.get('next-auth.session-token') || req.cookies.get('__Secure-next-auth.session-token') || req.cookies.get('next-auth.session-token.0')
  const { pathname } = req.nextUrl
  const publicPaths = ['/login', '/register', '/', '/api/auth']
  if (publicPaths.some(p => pathname.startsWith(p)) || pathname.startsWith('/_next') || pathname.startsWith('/favicon') || pathname.startsWith('/uploads') ) {
    return NextResponse.next()
  }
  if(!isAuth){
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = { matcher: ['/((?!_next|favicon.ico).*)'] }
