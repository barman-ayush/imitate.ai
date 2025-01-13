import { auth, clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Export clerkMiddleware at the top level
export default clerkMiddleware();

// Middleware function
// export async function middleware(request: NextRequest) {
//   // List of public routes that don't require authentication
//   const publicRoutes = ['/', '/api/webhook'];
//   const isPublicRoute = publicRoutes.some(route => 
//     request.nextUrl.pathname.startsWith(route)
//   );

//   // If the route is public, allow access
//   if (isPublicRoute) {
//     return NextResponse.next();
//   }

//   // Get auth state
//   const { userId } = await auth();

//   // If no userId and route is protected, redirect to sign-in
//   if (!userId) {
//     return NextResponse.redirect(new URL('/sign-in', request.url));
//   }

//   return NextResponse.next();
// }

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public (public files)
     */
    "/((?!static|.*\\..*|_next|favicon.ico).*)",
    "/(api|trpc)(.*)",
  ],
};