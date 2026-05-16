"use strict";

// ============================================================
//  INDUSKRITI — B2B Wholesale Backend  |  server.js
//  v2 — Five upgrades:
//   1. CompanySettings persisted to MongoDB (GET/PATCH /api/admin/settings)
//   2. Sequential bill numbers (billNumber auto-assigned on Confirmed)
//   3. Manual discount field on orders
//   4. Full order editing: new items array accepted, product lookup re-prices
//   5. Admin POS order creator (POST /api/admin/orders/pos)
// ============================================================

const express       = require("express");
const mongoose      = require("mongoose");
const bcrypt        = require("bcryptjs");
const jwt           = require("jsonwebtoken");
const cors          = require("cors");
const dotenv        = require("dotenv");
const multer        = require("multer");
const path          = require("path");
const fs            = require("fs");
const { nanoid }    = require("nanoid");
const Joi           = require("joi");

dotenv.config();

// ============================================================
// §1  ENVIRONMENT & CONSTANTS
// ============================================================
const PORT         = process.env.PORT          || 5000;
const MONGO_URI    = process.env.MONGO_URI     || "mongodb://127.0.0.1:27017/induskriti";
const JWT_SECRET   = process.env.JWT_SECRET    || "CHANGE_ME_IN_PRODUCTION";
const JWT_EXPIRES  = process.env.JWT_EXPIRES   || "7d";
const UPLOAD_DIR   = process.env.UPLOAD_DIR    || "uploads";
const WHATSAPP_NUM = process.env.WHATSAPP_NUM  || "919999999999";

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });


// ============================================================
// §2  DATABASE CONNECTION
// ============================================================
const connectDB = async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser:    true,
      useUnifiedTopology: true,
    });
    console.log("✅  MongoDB connected:", mongoose.connection.host);
  } catch (err) {
    console.error("❌  MongoDB connection error:", err.message);
    process.exit(1);
  }
};


// ============================================================
// §3  MONGOOSE SCHEMAS & MODELS
// ============================================================

/* ── 3.1  User ─────────────────────────────────────────── */
const addressSchema = new mongoose.Schema(
  {
    line1:   { type: String },
    line2:   { type: String },
    city:    { type: String },
    state:   { type: String },
    pincode: { type: String },
    country: { type: String, default: "India" },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name:          { type: String,  required: true, trim: true },
    email:         { type: String,  required: true, unique: true, lowercase: true, trim: true },
    phone:         { type: String,  required: true, trim: true },
    password:      { type: String,  required: true, select: false },
    role:          { type: String,  enum: ["admin", "b2b_buyer"], default: "b2b_buyer" },
    companyName:   { type: String,  trim: true },
    gstNumber:     { type: String,  trim: true, uppercase: true },
    aadhaarNumber: { type: String,  trim: true },
    address:       addressSchema,
    isActive:      { type: Boolean, default: true },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

const User = mongoose.model("User", userSchema);


/* ── 3.2  Category ─────────────────────────────────────── */
const categorySchema = new mongoose.Schema(
  {
    name:           { type: String,  required: true, trim: true },
    slug:           { type: String,  required: true, unique: true, lowercase: true, trim: true },
    parentCategory: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },
    isActive:       { type: Boolean, default: true },
  },
  { timestamps: true }
);

const Category = mongoose.model("Category", categorySchema);

/* ── 3.2.5  Series ─────────────────────────────────────── */
const seriesSchema = new mongoose.Schema(
  {
    name:        { type: String,  required: true, trim: true },
    slug:        { type: String,  required: true, unique: true, lowercase: true, trim: true },
    description: { type: String,  trim: true },
    isActive:    { type: Boolean, default: true },
  },
  { timestamps: true }
);

const Series = mongoose.model("Series", seriesSchema);


/* ── 3.3  Product ──────────────────────────────────────── */
const productSchema = new mongoose.Schema(
  {
    name:        { type: String,  required: true, trim: true },
    slug:        { type: String,  required: true, unique: true, lowercase: true, trim: true },
    sku:         { type: String,  required: true, unique: true, uppercase: true, trim: true },
    category:    { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    series:      { type: mongoose.Schema.Types.ObjectId, ref: "Series", default: null },
    description: { type: String,  trim: true },
    basePrice:   { type: Number,  required: true, min: 0 },
    images:      [{ type: String }],
    isActive:    { type: Boolean, default: true },
  },
  { timestamps: true }
);

const Product = mongoose.model("Product", productSchema);


/* ── 3.4  Order ────────────────────────────────────────── */
// NEW fields: billNumber, manualDiscount
const orderItemSchema = new mongoose.Schema(
  {
    productId:       { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name:            { type: String,  required: true },
    sku:             { type: String,  required: true },
    qty:             { type: Number,  required: true, min: 1 },
    priceAtPurchase: { type: Number,  required: true, min: 0 },
    lineTotal:       { type: Number,  required: true, min: 0 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderId:        { type: String,  required: true, unique: true },
    // Sequential bill number — assigned when status moves to Confirmed (or POS creation)
    billNumber:     { type: Number,  default: null, index: true },
    user:           { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    items:          [orderItemSchema],
    subtotal:       { type: Number,  required: true, min: 0 },
    discount:       { type: Number,  default: 0,     min: 0 },   // coupon discount
    manualDiscount: { type: Number,  default: 0,     min: 0 },   // NEW: admin-applied discount
    packingCharge:  { type: Number,  default: 0,     min: 0 },
    shippingCharge: { type: Number,  default: 0,     min: 0 },
    totalAmount:    { type: Number,  required: true, min: 0 },
    couponCode:     { type: String,  default: null },
    status: {
      type:    String,
      enum:    ["Pending_WhatsApp", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"],
      default: "Pending_WhatsApp",
    },
    // POS orders have no registered user — store buyer info inline
    posCustomer: {
      name:        { type: String },
      phone:       { type: String },
      companyName: { type: String },
      gstNumber:   { type: String },
      email:       { type: String },
    },
    shippingDetails: {
      name:    { type: String },
      phone:   { type: String },
      address: addressSchema,
    },
    adminNotes:  { type: String, default: "" },
    source:      { type: String, enum: ["web", "pos"], default: "web" },  // NEW
  },
  { timestamps: true }
);

const Order = mongoose.model("Order", orderSchema);


/* ── 3.5  Coupon ───────────────────────────────────────── */
const couponSchema = new mongoose.Schema(
  {
    code:         { type: String,  required: true, unique: true, uppercase: true, trim: true },
    discountType: { type: String,  enum: ["percent", "fixed"], required: true },
    value:        { type: Number,  required: true, min: 0 },
    minOrderAmt:  { type: Number,  default: 0 },
    maxUses:      { type: Number,  default: null },
    usedCount:    { type: Number,  default: 0 },
    expiryDate:   { type: Date,    required: true },
    isActive:     { type: Boolean, default: true },
  },
  { timestamps: true }
);

const Coupon = mongoose.model("Coupon", couponSchema);


/* ── 3.6  CompanySettings (NEW) ────────────────────────── */
// Singleton document — always upserted with key "default"
const companySettingsSchema = new mongoose.Schema(
  {
    key:        { type: String, default: "default", unique: true },
    name:       { type: String, default: "Induskriti" },
    tagline:    { type: String },
    gstNumber:  { type: String },
    phone:      { type: String },
    email:      { type: String },
    website:    { type: String },
    address:    { type: String },
    upiId:      { type: String },
    bankDetails:{ type: String },
    invoicePrefix: { type: String, default: "IK-INV-" },
    gstRate:    { type: Number, default: 0 },
    termsNotes: { type: String },
    signatureUrl:  { type: String },
  },
  { timestamps: true }
);

const CompanySettings = mongoose.model("CompanySettings", companySettingsSchema);


// ============================================================
// §4  MULTER — IMAGE UPLOAD CONFIGURATION
// ============================================================
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = `${Date.now()}-${nanoid(6)}${ext}`;
    cb(null, name);
  },
});

const fileFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const ok = allowed.test(path.extname(file.originalname).toLowerCase()) &&
             allowed.test(file.mimetype);
  if (ok) cb(null, true);
  else     cb(new AppError("Only jpeg, jpg, png, webp images are allowed", 400), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});


// ============================================================
// §5  CUSTOM ERROR CLASS
// ============================================================
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode || 500;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}


// ============================================================
// §6  UTILITY HELPERS
// ============================================================
const signToken = (user) =>
  jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

const generateOrderId = () => `IND-${nanoid(6).toUpperCase()}`;

const buildWhatsAppMessage = (order, user) => {
  const lines = order.items.map(
    (i) => `• ${i.name} (SKU: ${i.sku}) × ${i.qty} @ ₹${i.priceAtPurchase} = ₹${i.lineTotal}`
  );
  const buyer = user || order.posCustomer || {};
  return (
    `*New B2B Order — Induskriti*\n\n` +
    `Order ID: *${order.orderId}*\n` +
    `Buyer: ${buyer.name || "—"} | ${buyer.companyName || "N/A"}\n` +
    `GST: ${buyer.gstNumber || "N/A"}\n` +
    `Phone: ${buyer.phone || "—"}\n\n` +
    `*Items:*\n${lines.join("\n")}\n\n` +
    `Subtotal        : ₹${order.subtotal}\n` +
    `Coupon Discount : ₹${order.discount}\n` +
    `Manual Discount : ₹${order.manualDiscount || 0}\n` +
    `Packing Charge  : ₹${order.packingCharge}\n` +
    `Shipping Charge : ₹${order.shippingCharge}\n` +
    `*Total          : ₹${order.totalAmount}*\n\n` +
    `Please confirm this order at the earliest.`
  );
};

const toSlug = (str) =>
  str.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Assigns the next sequential bill number to an order.
 * Finds MAX(billNumber) across all orders and adds 1.
 * Thread-safe enough for low-concurrency admin use.
 */
const assignBillNumber = async (order) => {
  const last = await Order.findOne({ billNumber: { $ne: null } }).sort({ billNumber: -1 }).select("billNumber");
  order.billNumber = (last?.billNumber || 0) + 1;
};

/**
 * Core math engine — recalculates all monetary fields for an order.
 * Called by both editOrder and posCreateOrder.
 *
 * @param {Array}  items           — array of { productId, qty }
 * @param {Object} opts
 * @param {number} opts.packingCharge
 * @param {number} opts.shippingCharge
 * @param {number} opts.manualDiscount
 * @param {string} opts.couponCode  — existing coupon to re-apply (or null)
 * @returns {Object} { updatedItems, subtotal, couponDiscount, manualDiscount, packingCharge, shippingCharge, totalAmount }
 */
const recalcOrder = async (items, opts = {}) => {
  const {
    packingCharge  = 0,
    shippingCharge = 0,
    manualDiscount = 0,
    couponCode     = null,
  } = opts;

  const updatedItems = [];
  let subtotal = 0;

  for (const item of items) {
    const product = await Product.findById(item.productId);
    if (!product || !product.isActive)
      throw new AppError(`Product '${item.productId}' not found or inactive.`, 404);

    const unitPrice = product.basePrice;
    const lineTotal = +(unitPrice * item.qty).toFixed(2);
    subtotal       += lineTotal;

    updatedItems.push({
      productId:       product._id,
      name:            product.name,
      sku:             product.sku,
      qty:             item.qty,
      priceAtPurchase: unitPrice,
      lineTotal,
    });
  }

  subtotal = +subtotal.toFixed(2);

  // Coupon discount
  let couponDiscount = 0;
  let resolvedCoupon = null;

  if (couponCode) {
    const coupon = await Coupon.findOne({ code: couponCode.toUpperCase() });
    if (coupon && coupon.isActive && coupon.expiryDate >= new Date()) {
      if (subtotal >= (coupon.minOrderAmt || 0)) {
        couponDiscount = coupon.discountType === "percent"
          ? +((subtotal * coupon.value) / 100).toFixed(2)
          : Math.min(coupon.value, subtotal);
        resolvedCoupon = coupon;
      }
    }
  }

  const md          = +Number(manualDiscount).toFixed(2);
  const pc          = +Number(packingCharge).toFixed(2);
  const sc          = +Number(shippingCharge).toFixed(2);
  const totalAmount = +(subtotal - couponDiscount - md + pc + sc).toFixed(2);

  return { updatedItems, subtotal, couponDiscount, manualDiscount: md, packingCharge: pc, shippingCharge: sc, totalAmount, resolvedCoupon };
};


// ============================================================
// §7  JOI VALIDATION SCHEMAS
// ============================================================
const V = {
  register: Joi.object({
    name:          Joi.string().min(2).max(80).required(),
    email:         Joi.string().email().required(),
    phone:         Joi.string().min(7).max(15).required(),
    password:      Joi.string().min(8).required(),
    companyName:   Joi.string().max(120).optional(),
    gstNumber:     Joi.string().max(20).optional(),
    aadhaarNumber: Joi.string().length(12).pattern(/^\d{12}$/).optional()
                      .messages({ "string.pattern.base": "Aadhaar number must be exactly 12 digits." }),
    address:       Joi.object({
      line1:   Joi.string().optional(),
      line2:   Joi.string().optional(),
      city:    Joi.string().optional(),
      state:   Joi.string().optional(),
      pincode: Joi.string().optional(),
      country: Joi.string().optional(),
    }).optional(),
  }),

  login: Joi.object({
    email:    Joi.string().email().required(),
    password: Joi.string().required(),
  }),

  category: Joi.object({
    name:           Joi.string().min(2).max(80).required(),
    slug:           Joi.string().optional(),
    parentCategory: Joi.string().hex().length(24).optional().allow(null),
    isActive:       Joi.boolean().optional(),
  }),

  series: Joi.object({
    name:        Joi.string().min(2).max(80).required(),
    slug:        Joi.string().optional(),
    description: Joi.string().max(500).optional(),
    isActive:    Joi.boolean().optional(),
  }),

  product: Joi.object({
    name:        Joi.string().min(2).max(200).required(),
    slug:        Joi.string().optional(),
    sku:         Joi.string().min(2).max(50).required(),
    category:    Joi.string().hex().length(24).required(),
    series:      Joi.string().hex().length(24).optional().allow(null, ""),
    description: Joi.string().max(5000).optional(),
    basePrice:   Joi.number().min(0).required(),
    isActive:    Joi.boolean().optional(),
  }),

  createOrder: Joi.object({
    items: Joi.array().items(
      Joi.object({
        productId: Joi.string().hex().length(24).required(),
        qty:       Joi.number().integer().min(1).required(),
      })
    ).min(1).required(),
    couponCode:      Joi.string().optional().allow("", null),
    aadhaarNumber:   Joi.string().length(12).pattern(/^\d{12}$/).optional()
                        .messages({ "string.pattern.base": "Aadhaar number must be exactly 12 digits." }),
    shippingDetails: Joi.object({
      name:    Joi.string().optional(),
      phone:   Joi.string().optional(),
      address: Joi.object({
        line1:   Joi.string().optional(),
        line2:   Joi.string().optional(),
        city:    Joi.string().optional(),
        state:   Joi.string().optional(),
        pincode: Joi.string().optional(),
        country: Joi.string().optional(),
      }).optional(),
    }).optional(),
  }),

  updateOrderStatus: Joi.object({
    status:     Joi.string().valid("Confirmed", "Processing", "Shipped", "Delivered", "Cancelled").required(),
    adminNotes: Joi.string().max(500).optional(),
  }),

  // Full order edit — items array + all charge/discount fields
  editOrder: Joi.object({
    items: Joi.array().items(
      Joi.object({
        productId: Joi.string().hex().length(24).required(),
        qty:       Joi.number().integer().min(1).required(),
      })
    ).min(1).required(),
    packingCharge:  Joi.number().min(0).default(0),
    shippingCharge: Joi.number().min(0).default(0),
    manualDiscount: Joi.number().min(0).default(0),   // NEW
  }),

  coupon: Joi.object({
    code:         Joi.string().min(3).max(30).required(),
    discountType: Joi.string().valid("percent", "fixed").required(),
    value:        Joi.number().min(0).required(),
    minOrderAmt:  Joi.number().min(0).optional(),
    maxUses:      Joi.number().integer().min(1).optional().allow(null),
    expiryDate:   Joi.date().greater("now").required(),
    isActive:     Joi.boolean().optional(),
  }),

  // Company settings PATCH
  companySettings: Joi.object({
    name:          Joi.string().max(120).optional(),
    tagline:       Joi.string().max(200).optional().allow(""),
    gstNumber:     Joi.string().max(30).optional().allow(""),
    phone:         Joi.string().max(20).optional().allow(""),
    email:         Joi.string().email().optional().allow(""),
    website:       Joi.string().max(200).optional().allow(""),
    address:       Joi.string().max(500).optional().allow(""),
    upiId:         Joi.string().max(100).optional().allow(""),
    bankDetails:   Joi.string().max(300).optional().allow(""),
    invoicePrefix: Joi.string().max(20).optional().allow(""),
    gstRate:       Joi.number().min(0).max(100).optional(),
    termsNotes:    Joi.string().max(500).optional().allow(""),
    signatureUrl:  Joi.string().max(500).optional().allow(""),
  }),

  // POS order creation
  posOrder: Joi.object({
    customer: Joi.object({
      name:        Joi.string().required(),
      phone:       Joi.string().optional().allow(""),
      companyName: Joi.string().optional().allow(""),
      gstNumber:   Joi.string().optional().allow(""),
      email:       Joi.string().email().optional().allow(""),
    }).required(),
    items: Joi.array().items(
      Joi.object({
        productId: Joi.string().hex().length(24).required(),
        qty:       Joi.number().integer().min(1).required(),
      })
    ).min(1).required(),
    couponCode:     Joi.string().optional().allow("", null),
    packingCharge:  Joi.number().min(0).default(0),
    shippingCharge: Joi.number().min(0).default(0),
    manualDiscount: Joi.number().min(0).default(0),
    adminNotes:     Joi.string().max(500).optional().allow(""),
    status:         Joi.string().valid("Confirmed", "Processing", "Pending_WhatsApp").default("Confirmed"),
  }),
};


// ============================================================
// §8  MIDDLEWARE
// ============================================================
const validate = (schema) => (req, _res, next) => {
  const { error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    const msg = error.details.map((d) => d.message).join("; ");
    return next(new AppError(msg, 422));
  }
  next();
};

const protect = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer "))
    throw new AppError("Authentication required. Please log in.", 401);

  const token = header.split(" ")[1];
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    throw new AppError("Invalid or expired token. Please log in again.", 401);
  }

  const user = await User.findById(decoded.id);
  if (!user || !user.isActive)
    throw new AppError("User no longer exists or has been deactivated.", 401);

  req.user = user;
  next();
});

const restrictTo = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role))
    return next(new AppError("You do not have permission to perform this action.", 403));
  next();
};

// eslint-disable-next-line no-unused-vars
const globalErrorHandler = (err, _req, res, _next) => {
  let statusCode = err.statusCode || 500;
  let message    = err.message    || "Internal Server Error";

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "field";
    message    = `Duplicate value for '${field}'. Please use a different value.`;
    statusCode = 409;
  }

  if (err.name === "ValidationError") {
    message    = Object.values(err.errors).map((e) => e.message).join("; ");
    statusCode = 422;
  }

  if (err.name === "CastError") {
    message    = `Invalid ${err.path}: ${err.value}`;
    statusCode = 400;
  }

  const isProd = process.env.NODE_ENV === "production";
  res.status(statusCode).json({
    success: false,
    message,
    ...(isProd ? {} : { stack: err.stack }),
  });
};


// ============================================================
// §9  CONTROLLERS
// ============================================================

/* ─────────────────────────────────────────────────────────
   9.1  AUTH CONTROLLERS
   ───────────────────────────────────────────────────────── */
const authCtrl = {
  register: asyncHandler(async (req, res) => {
    const { name, email, phone, password, companyName, gstNumber, aadhaarNumber, address } = req.body;
    const existing = await User.findOne({ email });
    if (existing) throw new AppError("Email already registered.", 409);
    const user = await User.create({ name, email, phone, password, companyName, gstNumber, aadhaarNumber, address });
    const token = signToken(user);
    res.status(201).json({
      success: true,
      message: "Registration successful.",
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, companyName: user.companyName },
    });
  }),

  login: asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select("+password");
    if (!user || !(await user.comparePassword(password)))
      throw new AppError("Invalid email or password.", 401);
    if (!user.isActive) throw new AppError("Your account has been deactivated.", 403);
    const token = signToken(user);
    res.json({
      success: true,
      message: "Login successful.",
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, companyName: user.companyName },
    });
  }),

  getMe: asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
    res.json({ success: true, user });
  }),

  updateMe: asyncHandler(async (req, res) => {
    const allowed = ["name", "phone", "companyName", "gstNumber", "aadhaarNumber", "address"];
    const updates = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
    res.json({ success: true, message: "Profile updated.", user });
  }),
};


/* ─────────────────────────────────────────────────────────
   9.1.5  COMPANY SETTINGS CONTROLLERS  (NEW)
   ───────────────────────────────────────────────────────── */
const settingsCtrl = {
  /** GET /api/admin/settings  [admin] */
  get: asyncHandler(async (_req, res) => {
    // Returns the singleton, creating it with defaults if it doesn't yet exist
    const settings = await CompanySettings.findOneAndUpdate(
      { key: "default" },
      { $setOnInsert: { key: "default" } },
      { upsert: true, new: true }
    );
    res.json({ success: true, settings });
  }),

  /** PATCH /api/admin/settings  [admin] */
  update: asyncHandler(async (req, res) => {
    const allowed = [
      "name", "tagline", "gstNumber", "phone", "email", "website",
      "address", "upiId", "bankDetails", "invoicePrefix", "gstRate",
      "termsNotes", "signatureUrl",
    ];
    const updates = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    const settings = await CompanySettings.findOneAndUpdate(
      { key: "default" },
      { $set: updates },
      { upsert: true, new: true, runValidators: true }
    );
    res.json({ success: true, message: "Company settings saved.", settings });
  }),
};


/* ─────────────────────────────────────────────────────────
   9.2  CATEGORY CONTROLLERS
   ───────────────────────────────────────────────────────── */
const categoryCtrl = {
  create: asyncHandler(async (req, res) => {
    const { name, slug, parentCategory, isActive } = req.body;
    const category = await Category.create({ name, slug: slug || toSlug(name), parentCategory: parentCategory || null, isActive: isActive ?? true });
    res.status(201).json({ success: true, category });
  }),

  getAll: asyncHandler(async (_req, res) => {
    const cats = await Category.find({ isActive: true }).populate("parentCategory", "name slug");
    res.json({ success: true, count: cats.length, categories: cats });
  }),

  getOne: asyncHandler(async (req, res) => {
    const cat = await Category.findById(req.params.id).populate("parentCategory", "name slug");
    if (!cat) throw new AppError("Category not found.", 404);
    res.json({ success: true, category: cat });
  }),

  update: asyncHandler(async (req, res) => {
    const { name, slug, parentCategory, isActive } = req.body;
    const updates = {};
    if (name !== undefined) { updates.name = name; updates.slug = slug || toSlug(name); }
    if (slug !== undefined) updates.slug = slug;
    if (parentCategory !== undefined) updates.parentCategory = parentCategory;
    if (isActive !== undefined) updates.isActive = isActive;
    const cat = await Category.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!cat) throw new AppError("Category not found.", 404);
    res.json({ success: true, category: cat });
  }),

  remove: asyncHandler(async (req, res) => {
    const cat = await Category.findByIdAndDelete(req.params.id);
    if (!cat) throw new AppError("Category not found.", 404);
    res.json({ success: true, message: "Category deleted." });
  }),
};


/* ─────────────────────────────────────────────────────────
   9.2.5  SERIES CONTROLLERS
   ───────────────────────────────────────────────────────── */
const seriesCtrl = {
  create: asyncHandler(async (req, res) => {
    const { name, slug, description, isActive } = req.body;
    const series = await Series.create({ name, slug: slug || toSlug(name), description, isActive: isActive ?? true });
    res.status(201).json({ success: true, series });
  }),

  getAll: asyncHandler(async (_req, res) => {
    const series = await Series.find({ isActive: true }).sort({ createdAt: -1 });
    res.json({ success: true, count: series.length, series });
  }),

  getOne: asyncHandler(async (req, res) => {
    const series = await Series.findById(req.params.id);
    if (!series) throw new AppError("Series not found.", 404);
    res.json({ success: true, series });
  }),

  update: asyncHandler(async (req, res) => {
    const { name, slug, description, isActive } = req.body;
    const updates = {};
    if (name !== undefined) { updates.name = name; updates.slug = slug || toSlug(name); }
    if (slug !== undefined) updates.slug = slug;
    if (description !== undefined) updates.description = description;
    if (isActive !== undefined) updates.isActive = isActive;
    const series = await Series.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!series) throw new AppError("Series not found.", 404);
    res.json({ success: true, series });
  }),

  remove: asyncHandler(async (req, res) => {
    const series = await Series.findByIdAndDelete(req.params.id);
    if (!series) throw new AppError("Series not found.", 404);
    res.json({ success: true, message: "Series deleted." });
  }),
};


/* ─────────────────────────────────────────────────────────
   9.3  PRODUCT CONTROLLERS
   ───────────────────────────────────────────────────────── */
const productCtrl = {
  create: asyncHandler(async (req, res) => {
    const { name, slug, sku, category, series, description, basePrice, isActive } = req.body;
    const images = req.files ? req.files.map((f) => `/${UPLOAD_DIR}/${f.filename}`) : [];
    const product = await Product.create({
      name, slug: slug || toSlug(name), sku, category, series: series || null,
      description, basePrice: Number(basePrice), images,
      isActive: isActive !== undefined ? isActive === "true" || isActive === true : true,
    });
    res.status(201).json({ success: true, product });
  }),

  getAll: asyncHandler(async (req, res) => {
    const { category, minPrice, maxPrice, search, page = 1, limit = 20 } = req.query;
    const filter = { isActive: true };
    if (category) filter.category = category;
    if (search) filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { sku:  { $regex: search, $options: "i" } },
    ];
    if (minPrice || maxPrice) {
      filter.basePrice = {};
      if (minPrice) filter.basePrice.$gte = Number(minPrice);
      if (maxPrice) filter.basePrice.$lte = Number(maxPrice);
    }
    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Product.countDocuments(filter);
    const products = await Product.find(filter)
      .populate("category", "name slug")
      .populate("series", "name slug")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));
    res.json({ success: true, total, page: Number(page), pages: Math.ceil(total / Number(limit)), products });
  }),

  getOne: asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id)
      .populate("category", "name slug")
      .populate("series", "name slug");
    if (!product || !product.isActive) throw new AppError("Product not found.", 404);
    res.json({ success: true, product });
  }),

  update: asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw new AppError("Product not found.", 404);
    const fields = ["name", "slug", "sku", "category", "series", "description", "isActive"];
    fields.forEach((k) => { if (req.body[k] !== undefined) product[k] = req.body[k]; });
    if (req.body.basePrice !== undefined) product.basePrice = Number(req.body.basePrice);
    if (req.files && req.files.length > 0) {
      const newImages = req.files.map((f) => `/${UPLOAD_DIR}/${f.filename}`);
      product.images.push(...newImages);
    }
    await product.save();
    res.json({ success: true, product });
  }),

  remove: asyncHandler(async (req, res) => {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) throw new AppError("Product not found.", 404);
    res.json({ success: true, message: "Product deleted." });
  }),

  removeImage: asyncHandler(async (req, res) => {
    const { imageUrl } = req.body;
    if (!imageUrl) throw new AppError("imageUrl is required.", 400);
    const product = await Product.findById(req.params.id);
    if (!product) throw new AppError("Product not found.", 404);
    product.images = product.images.filter((img) => img !== imageUrl);
    await product.save();
    const relativePath = imageUrl.startsWith("/") ? imageUrl.slice(1) : imageUrl;
    const diskPath = path.join(process.cwd(), relativePath);
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
    res.json({ success: true, message: "Image removed.", images: product.images });
  }),
};


/* ─────────────────────────────────────────────────────────
   9.4  ORDER CONTROLLERS
   ───────────────────────────────────────────────────────── */
const orderCtrl = {

  /** POST /api/orders  — web checkout (buyer) */
  createOrder: asyncHandler(async (req, res) => {
    const { items, couponCode, shippingDetails } = req.body;
    const user = req.user;

    const result = await recalcOrder(items, { couponCode });

    const order = await Order.create({
      orderId: generateOrderId(),
      user:    user._id,
      items:   result.updatedItems,
      subtotal:       result.subtotal,
      discount:       result.couponDiscount,
      manualDiscount: 0,
      packingCharge:  0,
      shippingCharge: 0,
      totalAmount:    result.totalAmount,
      couponCode:     result.resolvedCoupon ? result.resolvedCoupon.code : null,
      status:  "Pending_WhatsApp",
      source:  "web",
      shippingDetails: shippingDetails || { name: user.name, phone: user.phone, address: user.address },
    });

    if (result.resolvedCoupon) {
      await Coupon.findByIdAndUpdate(result.resolvedCoupon._id, { $inc: { usedCount: 1 } });
    }

    const waMessage = buildWhatsAppMessage(order, user);
    const waLink    = `https://wa.me/${WHATSAPP_NUM}?text=${encodeURIComponent(waMessage)}`;

    res.status(201).json({
      success: true,
      message: "Order placed. Redirect user to WhatsApp to confirm.",
      orderId:         order.orderId,
      totalAmount:     order.totalAmount,
      whatsAppMessage: waMessage,
      whatsAppLink:    waLink,
    });
  }),

  getMyOrders: asyncHandler(async (req, res) => {
    const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, count: orders.length, orders });
  }),

  getMyOrder: asyncHandler(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) throw new AppError("Order not found.", 404);
    res.json({ success: true, order });
  }),

  /** GET /api/admin/orders  [admin] */
  getAllOrders: asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { orderId: { $regex: search, $options: "i" } },
      ];
    }
    const skip   = (Number(page) - 1) * Number(limit);
    const total  = await Order.countDocuments(filter);
    const orders = await Order.find(filter)
      .populate("user", "name email phone companyName gstNumber")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));
    res.json({ success: true, total, page: Number(page), pages: Math.ceil(total / Number(limit)), orders });
  }),

  /** GET /api/admin/orders/:id  [admin] */
  getOrderById: asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id)
      .populate("user", "name email phone companyName gstNumber aadhaarNumber address");
    if (!order) throw new AppError("Order not found.", 404);
    res.json({ success: true, order });
  }),

  /**
   * PATCH /api/admin/orders/:id/status  [admin]
   * If status changes to Confirmed and no billNumber yet, assign one.
   */
  updateOrderStatus: asyncHandler(async (req, res) => {
    const { status, adminNotes } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found.", 404);

    const wasConfirmed = order.status === "Confirmed";
    order.status = status;
    if (adminNotes !== undefined) order.adminNotes = adminNotes;

    // Assign bill number when first confirmed
    if (status === "Confirmed" && !order.billNumber) {
      await assignBillNumber(order);
    }

    await order.save();

    res.json({ success: true, message: `Order status updated to '${status}'.`, order });
  }),

  /**
   * PATCH /api/admin/orders/:id/edit  [admin]
   * Full re-edit: items array, manual discount, packing, shipping.
   * Also assigns bill number if confirming for the first time.
   */
  editOrder: asyncHandler(async (req, res) => {
    const { items, packingCharge = 0, shippingCharge = 0, manualDiscount = 0 } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found.", 404);

    const result = await recalcOrder(items, {
      packingCharge,
      shippingCharge,
      manualDiscount,
      couponCode: order.couponCode,
    });

    order.items          = result.updatedItems;
    order.subtotal       = result.subtotal;
    order.discount       = result.couponDiscount;
    order.manualDiscount = result.manualDiscount;
    order.packingCharge  = result.packingCharge;
    order.shippingCharge = result.shippingCharge;
    order.totalAmount    = result.totalAmount;

    await order.save();

    res.json({ success: true, message: "Order updated and totals recalculated.", order });
  }),

  /**
   * POST /api/admin/orders/pos  [admin]  (NEW — Update 5)
   * Walk-in / WhatsApp POS order. Admin provides customer info inline,
   * no registered user required. Auto-assigns bill number.
   */
  posCreateOrder: asyncHandler(async (req, res) => {
    const {
      customer,
      items,
      couponCode,
      packingCharge  = 0,
      shippingCharge = 0,
      manualDiscount = 0,
      adminNotes     = "",
      status         = "Confirmed",
    } = req.body;

    // Find or create a lightweight "ghost" user for this customer
    // so the order schema's required user field is satisfied.
    // We use a special admin-created placeholder user.
    let ghostUser = await User.findOne({ email: "pos-ghost@induskriti.internal" }).select("_id");
    if (!ghostUser) {
      ghostUser = await User.create({
        name:  "POS Customer",
        email: "pos-ghost@induskriti.internal",
        phone: "0000000000",
        password: nanoid(32),   // random unguessable password
        role: "b2b_buyer",
        isActive: false,        // can't login
      });
    }

    const result = await recalcOrder(items, { couponCode, packingCharge, shippingCharge, manualDiscount });

    const order = await Order.create({
      orderId:        generateOrderId(),
      user:           ghostUser._id,
      posCustomer:    customer,
      items:          result.updatedItems,
      subtotal:       result.subtotal,
      discount:       result.couponDiscount,
      manualDiscount: result.manualDiscount,
      packingCharge:  result.packingCharge,
      shippingCharge: result.shippingCharge,
      totalAmount:    result.totalAmount,
      couponCode:     result.resolvedCoupon ? result.resolvedCoupon.code : null,
      status,
      source:         "pos",
      adminNotes,
    });

    // Always assign bill number for POS orders
    await assignBillNumber(order);
    await order.save();

    if (result.resolvedCoupon) {
      await Coupon.findByIdAndUpdate(result.resolvedCoupon._id, { $inc: { usedCount: 1 } });
    }

    res.status(201).json({
      success: true,
      message: "POS order created.",
      orderId:     order.orderId,
      billNumber:  order.billNumber,
      totalAmount: order.totalAmount,
      order,
    });
  }),
};


/* ─────────────────────────────────────────────────────────
   9.5  COUPON CONTROLLERS
   ───────────────────────────────────────────────────────── */
const couponCtrl = {
  create: asyncHandler(async (req, res) => {
    const coupon = await Coupon.create(req.body);
    res.status(201).json({ success: true, coupon });
  }),

  getAll: asyncHandler(async (_req, res) => {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.json({ success: true, count: coupons.length, coupons });
  }),

  update: asyncHandler(async (req, res) => {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!coupon) throw new AppError("Coupon not found.", 404);
    res.json({ success: true, coupon });
  }),

  remove: asyncHandler(async (req, res) => {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) throw new AppError("Coupon not found.", 404);
    res.json({ success: true, message: "Coupon deleted." });
  }),

  validate: asyncHandler(async (req, res) => {
    const { code, orderAmount } = req.body;
    if (!code) throw new AppError("Coupon code is required.", 400);
    const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
    if (!coupon || coupon.expiryDate < new Date()) throw new AppError("Invalid or expired coupon.", 400);
    if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) throw new AppError("Coupon usage limit reached.", 400);
    const amount   = Number(orderAmount) || 0;
    const discount = coupon.discountType === "percent"
      ? +((amount * coupon.value) / 100).toFixed(2)
      : Math.min(coupon.value, amount);
    res.json({
      success: true,
      coupon: { code: coupon.code, discountType: coupon.discountType, value: coupon.value, discount, minOrderAmt: coupon.minOrderAmt },
    });
  }),
};


/* ─────────────────────────────────────────────────────────
   9.6  ADMIN — USER MANAGEMENT CONTROLLERS
   ───────────────────────────────────────────────────────── */
const adminUserCtrl = {
  getAll: asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, search } = req.query;
    const filter = {};
    if (search) filter.$or = [
      { name:  { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
    const skip  = (Number(page) - 1) * Number(limit);
    const total = await User.countDocuments(filter);
    const users = await User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit));
    res.json({ success: true, total, users });
  }),

  toggleActive: asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new AppError("User not found.", 404);
    user.isActive = !user.isActive;
    await user.save();
    res.json({ success: true, message: `User ${user.isActive ? "activated" : "deactivated"}.`, isActive: user.isActive });
  }),
};


// ============================================================
// §10  EXPRESS APP & ROUTES
// ============================================================
const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(`/${UPLOAD_DIR}`, express.static(path.resolve(process.cwd(), UPLOAD_DIR)));

app.get("/api/health", (_req, res) =>
  res.json({ success: true, message: "Induskriti API is running 🚀", timestamp: new Date() })
);

/* ── 10.1  Auth routes ──────────────────────────────────── */
const authRouter = express.Router();
authRouter.post("/register", validate(V.register), authCtrl.register);
authRouter.post("/login",    validate(V.login),    authCtrl.login);
authRouter.get( "/me",       protect,              authCtrl.getMe);
authRouter.patch("/me",      protect,              authCtrl.updateMe);
app.use("/api/auth", authRouter);

/* ── 10.2  Category routes ──────────────────────────────── */
const categoryRouter = express.Router();
categoryRouter.get("/",    categoryCtrl.getAll);
categoryRouter.get("/:id", categoryCtrl.getOne);
categoryRouter.post(  "/",    protect, restrictTo("admin"), validate(V.category), categoryCtrl.create);
categoryRouter.patch( "/:id", protect, restrictTo("admin"), validate(V.category), categoryCtrl.update);
categoryRouter.delete("/:id", protect, restrictTo("admin"),                        categoryCtrl.remove);
app.use("/api/categories", categoryRouter);

/* ── 10.2.5  Series routes ──────────────────────────────── */
const seriesRouter = express.Router();
seriesRouter.get("/",    seriesCtrl.getAll);
seriesRouter.get("/:id", seriesCtrl.getOne);
seriesRouter.post(  "/",    protect, restrictTo("admin"), validate(V.series), seriesCtrl.create);
seriesRouter.patch( "/:id", protect, restrictTo("admin"), validate(V.series), seriesCtrl.update);
seriesRouter.delete("/:id", protect, restrictTo("admin"),                       seriesCtrl.remove);
app.use("/api/series", seriesRouter);

/* ── 10.3  Product routes ───────────────────────────────── */
const productRouter = express.Router();
productRouter.get("/",    productCtrl.getAll);
productRouter.get("/:id", productCtrl.getOne);
productRouter.post(  "/",           protect, restrictTo("admin"), upload.array("images", 10), productCtrl.create);
productRouter.patch( "/:id",        protect, restrictTo("admin"), upload.array("images", 10), productCtrl.update);
productRouter.delete("/:id",        protect, restrictTo("admin"), productCtrl.remove);
productRouter.delete("/:id/images", protect, restrictTo("admin"), productCtrl.removeImage);
app.use("/api/products", productRouter);

/* ── 10.4  Order routes (buyer) ─────────────────────────── */
const orderRouter = express.Router();
orderRouter.use(protect);
orderRouter.post("/",   validate(V.createOrder), orderCtrl.createOrder);
orderRouter.get("/",    orderCtrl.getMyOrders);
orderRouter.get("/:id", orderCtrl.getMyOrder);
app.use("/api/orders", orderRouter);

/* ── 10.5  Coupon validation route (buyer) ──────────────── */
const couponRouter = express.Router();
couponRouter.post("/validate", protect, couponCtrl.validate);
app.use("/api/coupons", couponRouter);

/* ── 10.6  Admin routes ─────────────────────────────────── */
const adminRouter = express.Router();
adminRouter.use(protect, restrictTo("admin"));

// Admin → company settings  (NEW)
adminRouter.get(  "/settings", settingsCtrl.get);
adminRouter.patch("/settings", validate(V.companySettings), settingsCtrl.update);

// Admin → orders
adminRouter.get("/orders",                                                    orderCtrl.getAllOrders);
adminRouter.get("/orders/:id",                                                orderCtrl.getOrderById);
adminRouter.post("/orders/pos",   validate(V.posOrder),                       orderCtrl.posCreateOrder);  // NEW — must be before /:id routes
adminRouter.patch("/orders/:id/status", validate(V.updateOrderStatus),        orderCtrl.updateOrderStatus);
adminRouter.patch("/orders/:id/edit",   validate(V.editOrder),                orderCtrl.editOrder);

// Admin → coupons
adminRouter.post(  "/coupons",     validate(V.coupon), couponCtrl.create);
adminRouter.get(   "/coupons",                         couponCtrl.getAll);
adminRouter.patch( "/coupons/:id",                     couponCtrl.update);
adminRouter.delete("/coupons/:id",                     couponCtrl.remove);

// Admin → users
adminRouter.get(   "/users",            adminUserCtrl.getAll);
adminRouter.patch( "/users/:id/toggle", adminUserCtrl.toggleActive);

app.use("/api/admin", adminRouter);

/* ── 404 & global error handler ─────────────────────────── */
app.use((_req, _res, next) => next(new AppError("Route not found.", 404)));
app.use(globalErrorHandler);


// ============================================================
// §11  SERVER BOOTSTRAP
// ============================================================
const startServer = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀  Induskriti API running on http://localhost:${PORT}`);
    console.log(`📦  Environment : ${process.env.NODE_ENV || "development"}`);
    console.log(`📁  Uploads dir : ${UPLOAD_DIR}/`);
    console.log("\nRoute map (v2):");
    console.log("  GET    /api/admin/settings              ← NEW: DB company settings");
    console.log("  PATCH  /api/admin/settings              ← NEW: save to DB");
    console.log("  POST   /api/admin/orders/pos            ← NEW: POS/walk-in order");
    console.log("  PATCH  /api/admin/orders/:id/status     ← assigns bill number on Confirmed");
    console.log("  PATCH  /api/admin/orders/:id/edit       ← manualDiscount + full item edit");
    console.log("  GET    /api/admin/orders");
    console.log("  POST   /api/orders                      ← web checkout");
    console.log("  POST   /api/coupons/validate");
    console.log("  GET    /api/products");
    console.log("  POST   /api/auth/register");
    console.log("  POST   /api/auth/login");
  });
};

startServer();
