'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function Page(){
  const r = useRouter()
  const [form, setForm] = useState({ name:'', email:'', password:'' })
  const on = (k:string)=> (e:any)=> setForm(p=> ({...p, [k]: e.target.value}))
  const submit = async(e:any)=>{
    e.preventDefault()
    const res = await fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(form) })
    if(res.ok) r.push('/login')
    else alert('No se pudo registrar')
  }
  return (<div className="max-w-md mx-auto bg-white p-6 rounded-2xl shadow">
    <h1 className="text-xl font-semibold mb-4">Crear cuenta</h1>
    <form onSubmit={submit} className="grid gap-3">
      <input className="border rounded-xl px-3 py-2" placeholder="Nombre" value={form.name} onChange={on('name')} />
      <input className="border rounded-xl px-3 py-2" placeholder="Email" value={form.email} onChange={on('email')} />
      <input type="password" className="border rounded-xl px-3 py-2" placeholder="Password" value={form.password} onChange={on('password')} />
      <button className="px-4 py-2 rounded-xl bg-black text-white">Registrar</button>
    </form>
  </div>)
}
