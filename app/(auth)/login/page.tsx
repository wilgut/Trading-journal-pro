'use client'
import { signIn } from 'next-auth/react'
import { useState } from 'react'

export default function Page(){
  const [form, setForm] = useState({ email:'', password:'' })
  const on = (k:string)=> (e:any)=> setForm(p=> ({...p, [k]: e.target.value}))
  return (<div className="max-w-md mx-auto bg-white p-6 rounded-2xl shadow">
    <h1 className="text-xl font-semibold mb-4">Iniciar sesión</h1>
    <div className="grid gap-3">
      <input className="border rounded-xl px-3 py-2" placeholder="Email" value={form.email} onChange={on('email')} />
      <input type="password" className="border rounded-xl px-3 py-2" placeholder="Password" value={form.password} onChange={on('password')} />
      <button onClick={()=>signIn('credentials', { email: form.email, password: form.password, callbackUrl: '/dashboard' })} className="px-4 py-2 rounded-xl bg-black text-white">Entrar</button>
    </div>
  </div>)
}
