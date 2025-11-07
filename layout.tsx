import './globals.css'
import React from 'react'

export const metadata = {
  title: 'Trading Journal Pro',
  description: 'Registro de operaciones y analítica para traders',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen">
        <div className="max-w-6xl mx-auto p-4">{children}</div>
      </body>
    </html>
  )
}
