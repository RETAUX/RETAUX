// Central definition of document categories required per tax year.
// Used by the documents page, upload validation, and the dashboard checklist.

module.exports = [
  {
    id: 'payslips',
    label: 'Payslips — Recibos de sueldo',
    description: 'Recibos de sueldo de cada trabajo. Si no tenés todos, al menos subí el último recibo de cada empleo del año fiscal.',
    multiple: true
  },
  {
    id: 'abn_income',
    label: 'Ingresos con ABN',
    description: 'Si trabajaste con ABN: comprobantes, facturas o un registro (aunque sea informal) con fechas y montos recibidos.',
    multiple: true
  },
  {
    id: 'logbook',
    label: 'D1 — Gastos de auto relacionados al trabajo',
    description: 'Logbook de km de trabajo, recibos de combustible, service, peajes. Requerido si usás tu auto para trabajar.',
    multiple: true
  },
  {
    id: 'work_travel',
    label: 'D2 — Gastos de viaje de trabajo (no auto)',
    description: 'Vuelos, trenes, taxis, Uber, accommodation pagados para ir a un sitio de trabajo diferente al habitual. NO incluye el viaje diario casa-trabajo.',
    multiple: true
  },
  {
    id: 'work_expenses',
    label: 'D3 — Ropa, uniforme y lavandería',
    description: 'Recibos de compra de uniformes, ropa de trabajo específica (con logo o protección), calzado de seguridad. Incluye gastos de lavandería.',
    multiple: true
  },
  {
    id: 'training',
    label: 'D4 — Educación y capacitación relacionada al trabajo',
    description: 'Comprobante de pago de cursos, capacitaciones o formaciones directamente relacionadas con tu trabajo actual (no para conseguir un nuevo trabajo).',
    multiple: true
  },
  {
    id: 'certifications',
    label: 'D5 — Certificaciones y licencias de trabajo',
    description: 'RSA, White Card, licencias o habilitaciones requeridas para trabajar. También fees de asociaciones o sindicatos.',
    multiple: true
  },
  {
    id: 'tech_purchases',
    label: 'D5 — Tecnología, teléfono y otros gastos de trabajo',
    description: 'Celular, computadora, internet (porcentaje de uso laboral). Herramientas, materiales de trabajo menores a $300. Combustible y service de auto si aplica D5.',
    multiple: true
  },
  {
    id: 'home_office',
    label: 'D6 — Home office / Trabajo desde casa',
    description: 'Gastos del hogar relacionados con el trabajo remoto: electricidad, internet, alquiler proporcional. Necesitás llevar registro de horas trabajadas desde casa.',
    multiple: true
  },
  {
    id: 'investment_statements',
    label: 'Inversiones financieras',
    description: 'Si tenés inversiones (acciones, cripto, etc.), un estado global del período que muestre tus ganancias o pérdidas.',
    multiple: true
  },
  {
    id: 'donation_receipts',
    label: 'D9 — Donaciones (tax-deductible)',
    description: 'Recibos de donaciones SOLO si son deducibles de impuestos (tax-deductible receipt). La entidad debe estar registrada como DGR.',
    multiple: true
  }
];
