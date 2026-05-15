"use strict";

// ============================================================
//  INDUSKRITI — B2B Wholesale Backend  |  server.js
//  Single-file monolith: Config → Models → Middleware →
//  Controllers → Routes → Server bootstrap
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
const WHATSAPP_NUM = process.env.WHATSAPP_NUM  || "919999999999"; // country code + number, no +

// Ensure upload directory exists
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
    name:        { type: String,  required: true, trim: true },
    email:       { type: String,  required: true, unique: true, lowercase: true, trim: true },
    phone:       { type: String,  required: true, trim: true },
    password:    { type: String,  required: true, select: false },
    role:        { type: String,  enum: ["admin", "b2b_buyer"], default: "b2b_buyer" },
    companyName: { type: String,  trim: true },
    gstNumber:   { type: String,  trim: true, uppercase: true },
    address:     addressSchema,
    isActive:    { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Hash password before save
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Instance method — compare password
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

/* ── 3.2.5 Series ─────────────────────────────────────── */
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
// NOTE: priceTierSchema, moq, stockCount, and priceTiers have been removed.
// Pricing is now flat: quantity × basePrice only.
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
    orderId:     { type: String,  required: true, unique: true },
    user:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    items:       [orderItemSchema],
    subtotal:    { type: Number,  required: true, min: 0 },
    discount:    { type: Number,  default: 0,     min: 0 },
    totalAmount: { type: Number,  required: true, min: 0 },
    couponCode:  { type: String,  default: null },
    status: {
      type:    String,
      enum:    ["Pending_WhatsApp", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"],
      default: "Pending_WhatsApp",
    },
    shippingDetails: {
      name:    { type: String },
      phone:   { type: String },
      address: addressSchema,
    },
    adminNotes:  { type: String, default: "" },
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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
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

/** Sign a JWT for a user document */
const signToken = (user) =>
  jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

/** Generate a human-readable order ID  e.g. IND-A3F9K2 */
const generateOrderId = () => `IND-${nanoid(6).toUpperCase()}`;

/** Build the WhatsApp pre-filled message */
const buildWhatsAppMessage = (order, user) => {
  const lines = order.items.map(
    (i) => `• ${i.name} (SKU: ${i.sku}) × ${i.qty} @ ₹${i.priceAtPurchase} = ₹${i.lineTotal}`
  );
  return (
    `*New B2B Order — Induskriti*\n\n` +
    `Order ID: *${order.orderId}*\n` +
    `Buyer: ${user.name} | ${user.companyName || "N/A"}\n` +
    `GST: ${user.gstNumber || "N/A"}\n` +
    `Phone: ${user.phone}\n\n` +
    `*Items:*\n${lines.join("\n")}\n\n` +
    `Subtotal : ₹${order.subtotal}\n` +
    `Discount : ₹${order.discount}\n` +
    `*Total   : ₹${order.totalAmount}*\n\n` +
    `Please confirm this order at the earliest.`
  );
};

/** Simple slug generator */
const toSlug = (str) =>
  str.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** Wrap async route handlers — eliminates repetitive try/catch */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);


// ============================================================
// §7  JOI VALIDATION SCHEMAS
// ============================================================
const V = {
  register: Joi.object({
    name:        Joi.string().min(2).max(80).required(),
    email:       Joi.string().email().required(),
    phone:       Joi.string().min(7).max(15).required(),
    password:    Joi.string().min(8).required(),
    companyName: Joi.string().max(120).optional(),
    gstNumber:   Joi.string().max(20).optional(),
    address:     Joi.object({
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

  // NOTE: moq, stockCount, and priceTiers validation removed.
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

  coupon: Joi.object({
    code:         Joi.string().min(3).max(30).required(),
    discountType: Joi.string().valid("percent", "fixed").required(),
    value:        Joi.number().min(0).required(),
    minOrderAmt:  Joi.number().min(0).optional(),
    maxUses:      Joi.number().integer().min(1).optional().allow(null),
    expiryDate:   Joi.date().greater("now").required(),
    isActive:     Joi.boolean().optional(),
  }),
};


// ============================================================
// §8  MIDDLEWARE
// ============================================================

/* ── 8.1  Joi validation factory ───────────────────────── */
const validate = (schema) => (req, _res, next) => {
  const { error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    const msg = error.details.map((d) => d.message).join("; ");
    return next(new AppError(msg, 422));
  }
  next();
};

/* ── 8.2  JWT authentication ────────────────────────────── */
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

/* ── 8.3  Role-based access guard ───────────────────────── */
const restrictTo = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role))
    return next(new AppError("You do not have permission to perform this action.", 403));
  next();
};

/* ── 8.4  Global error handler ──────────────────────────── */
// eslint-disable-next-line no-unused-vars
const globalErrorHandler = (err, _req, res, _next) => {
  let statusCode = err.statusCode || 500;
  let message    = err.message    || "Internal Server Error";

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "field";
    message    = `Duplicate value for '${field}'. Please use a different value.`;
    statusCode = 409;
  }

  // Mongoose validation error
  if (err.name === "ValidationError") {
    message    = Object.values(err.errors).map((e) => e.message).join("; ");
    statusCode = 422;
  }

  // Mongoose cast error (bad ObjectId)
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

  /** POST /api/auth/register */
  register: asyncHandler(async (req, res) => {
    const { name, email, phone, password, companyName, gstNumber, address } = req.body;

    const existing = await User.findOne({ email });
    if (existing) throw new AppError("Email already registered.", 409);

    const user = await User.create({ name, email, phone, password, companyName, gstNumber, address });
    const token = signToken(user);

    res.status(201).json({
      success: true,
      message: "Registration successful.",
      token,
      user: {
        id:          user._id,
        name:        user.name,
        email:       user.email,
        role:        user.role,
        companyName: user.companyName,
      },
    });
  }),

  /** POST /api/auth/login */
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
      user: {
        id:          user._id,
        name:        user.name,
        email:       user.email,
        role:        user.role,
        companyName: user.companyName,
      },
    });
  }),

  /** GET /api/auth/me */
  getMe: asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
    res.json({ success: true, user });
  }),

  /** PATCH /api/auth/me */
  updateMe: asyncHandler(async (req, res) => {
    const allowed = ["name", "phone", "companyName", "gstNumber", "address"];
    const updates = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
    res.json({ success: true, message: "Profile updated.", user });
  }),
};


/* ─────────────────────────────────────────────────────────
   9.2  CATEGORY CONTROLLERS
   ───────────────────────────────────────────────────────── */
const categoryCtrl = {

  /** POST /api/categories  [admin] */
  create: asyncHandler(async (req, res) => {
    const { name, slug, parentCategory, isActive } = req.body;
    const category = await Category.create({
      name,
      slug:           slug || toSlug(name),
      parentCategory: parentCategory || null,
      isActive:       isActive ?? true,
    });
    res.status(201).json({ success: true, category });
  }),

  /** GET /api/categories */
  getAll: asyncHandler(async (_req, res) => {
    const cats = await Category.find({ isActive: true }).populate("parentCategory", "name slug");
    res.json({ success: true, count: cats.length, categories: cats });
  }),

  /** GET /api/categories/:id */
  getOne: asyncHandler(async (req, res) => {
    const cat = await Category.findById(req.params.id).populate("parentCategory", "name slug");
    if (!cat) throw new AppError("Category not found.", 404);
    res.json({ success: true, category: cat });
  }),

  /** PATCH /api/categories/:id  [admin] */
  update: asyncHandler(async (req, res) => {
    const { name, slug, parentCategory, isActive } = req.body;
    const updates = {};
    if (name            !== undefined) { updates.name = name; updates.slug = slug || toSlug(name); }
    if (slug            !== undefined)  updates.slug           = slug;
    if (parentCategory  !== undefined)  updates.parentCategory = parentCategory;
    if (isActive        !== undefined)  updates.isActive       = isActive;

    const cat = await Category.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!cat) throw new AppError("Category not found.", 404);
    res.json({ success: true, category: cat });
  }),

  /** DELETE /api/categories/:id  [admin] */
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
  /** POST /api/series  [admin] */
  create: asyncHandler(async (req, res) => {
    const { name, slug, description, isActive } = req.body;
    const series = await Series.create({
      name,
      slug: slug || toSlug(name),
      description,
      isActive: isActive ?? true,
    });
    res.status(201).json({ success: true, series });
  }),

  /** GET /api/series */
  getAll: asyncHandler(async (_req, res) => {
    const series = await Series.find({ isActive: true }).sort({ createdAt: -1 });
    res.json({ success: true, count: series.length, series });
  }),

  /** GET /api/series/:id */
  getOne: asyncHandler(async (req, res) => {
    const series = await Series.findById(req.params.id);
    if (!series) throw new AppError("Series not found.", 404);
    res.json({ success: true, series });
  }),

  /** PATCH /api/series/:id  [admin] */
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

  /** DELETE /api/series/:id  [admin] */
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

  /**
   * POST /api/products  [admin] — multipart/form-data
   * Accepts: name, slug, sku, category, series, description, basePrice, isActive, images[]
   * moq, stockCount, priceTiers are no longer accepted or stored.
   */
  create: asyncHandler(async (req, res) => {
    const { name, slug, sku, category, series, description, basePrice, isActive } = req.body;

    // Collect uploaded image paths
    const images = req.files ? req.files.map((f) => `/${UPLOAD_DIR}/${f.filename}`) : [];

    const product = await Product.create({
      name,
      slug:       slug || toSlug(name),
      sku,
      category,
      series:     series || null,
      description,
      basePrice:  Number(basePrice),
      images,
      isActive:   isActive !== undefined ? isActive === "true" || isActive === true : true,
    });

    res.status(201).json({ success: true, product });
  }),

  /** GET /api/products */
  getAll: asyncHandler(async (req, res) => {
    const { category, minPrice, maxPrice, search, page = 1, limit = 20 } = req.query;
    const filter = { isActive: true };

    if (category)  filter.category = category;
    if (search)    filter.$or = [
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

    res.json({
      success: true,
      total,
      page:  Number(page),
      pages: Math.ceil(total / Number(limit)),
      products,
    });
  }),

  /** GET /api/products/:id */
  getOne: asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id)
      .populate("category", "name slug")
      .populate("series", "name slug");
    if (!product || !product.isActive) throw new AppError("Product not found.", 404);
    res.json({ success: true, product });
  }),

  /**
   * PATCH /api/products/:id  [admin] — multipart/form-data
   * moq, stockCount, priceTiers are no longer accepted or stored.
   */
  update: asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw new AppError("Product not found.", 404);

    const fields = ["name", "slug", "sku", "category", "series", "description", "isActive"];
    fields.forEach((k) => { if (req.body[k] !== undefined) product[k] = req.body[k]; });
    if (req.body.basePrice !== undefined) product.basePrice = Number(req.body.basePrice);

    // Append new images (keep existing ones too)
    if (req.files && req.files.length > 0) {
      const newImages = req.files.map((f) => `/${UPLOAD_DIR}/${f.filename}`);
      product.images.push(...newImages);
    }

    await product.save();
    res.json({ success: true, product });
  }),

  /** DELETE /api/products/:id  [admin] */
  remove: asyncHandler(async (req, res) => {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) throw new AppError("Product not found.", 404);
    res.json({ success: true, message: "Product deleted." });
  }),

  /** DELETE /api/products/:id/images  [admin] — remove specific image */
  removeImage: asyncHandler(async (req, res) => {
    const { imageUrl } = req.body;
    if (!imageUrl) throw new AppError("imageUrl is required.", 400);

    const product = await Product.findById(req.params.id);
    if (!product) throw new AppError("Product not found.", 404);

    product.images = product.images.filter((img) => img !== imageUrl);
    await product.save();

    // Delete from disk — strip leading slash before joining
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

  /**
   * POST /api/orders
   * WhatsApp Checkout Flow:
   *  1. Validate each item exists and is active
   *  2. Calculate line total: qty × basePrice (flat, no tiers, no MOQ, no stock check)
   *  3. Apply coupon if provided
   *  4. Save order as Pending_WhatsApp
   *  5. Return orderId + WhatsApp message + link
   */
  createOrder: asyncHandler(async (req, res) => {
    const { items, couponCode, shippingDetails } = req.body;
    const user = req.user;

    // ── Step 1: validate items & build order lines ──────────
    const orderItems = [];
    let subtotal = 0;

    for (const item of items) {
      const product = await Product.findById(item.productId);

      if (!product || !product.isActive)
        throw new AppError(`Product '${item.productId}' not found or inactive.`, 404);

      // Flat pricing: qty × basePrice (no tiers, no MOQ, no stock check)
      const unitPrice = product.basePrice;
      const lineTotal = +(unitPrice * item.qty).toFixed(2);
      subtotal       += lineTotal;

      orderItems.push({
        productId:       product._id,
        name:            product.name,
        sku:             product.sku,
        qty:             item.qty,
        priceAtPurchase: unitPrice,
        lineTotal,
      });
    }

    subtotal = +subtotal.toFixed(2);

    // ── Step 2: apply coupon ────────────────────────────────
    let discount   = 0;
    let usedCoupon = null;

    if (couponCode) {
      const coupon = await Coupon.findOne({ code: couponCode.toUpperCase(), isActive: true });

      if (!coupon)                        throw new AppError("Invalid coupon code.", 400);
      if (coupon.expiryDate < new Date()) throw new AppError("Coupon has expired.", 400);
      if (subtotal < coupon.minOrderAmt)  throw new AppError(`Minimum order amount for this coupon is ₹${coupon.minOrderAmt}.`, 400);
      if (coupon.maxUses && coupon.usedCount >= coupon.maxUses)
                                          throw new AppError("Coupon usage limit reached.", 400);

      discount = coupon.discountType === "percent"
        ? +((subtotal * coupon.value) / 100).toFixed(2)
        : Math.min(coupon.value, subtotal);

      usedCoupon = coupon;
    }

    const totalAmount = +(subtotal - discount).toFixed(2);

    // ── Step 3: save order ──────────────────────────────────
    const order = await Order.create({
      orderId: generateOrderId(),
      user:    user._id,
      items:   orderItems,
      subtotal,
      discount,
      totalAmount,
      couponCode: usedCoupon ? usedCoupon.code : null,
      status:  "Pending_WhatsApp",
      shippingDetails: shippingDetails || {
        name:    user.name,
        phone:   user.phone,
        address: user.address,
      },
    });

    // Increment coupon usage count
    if (usedCoupon) {
      await Coupon.findByIdAndUpdate(usedCoupon._id, { $inc: { usedCount: 1 } });
    }

    // ── Step 4: build WhatsApp redirect info ────────────────
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

  /** GET /api/orders  — buyer sees their own orders */
  getMyOrders: asyncHandler(async (req, res) => {
    const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, count: orders.length, orders });
  }),

  /** GET /api/orders/:id  — buyer sees their own order */
  getMyOrder: asyncHandler(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) throw new AppError("Order not found.", 404);
    res.json({ success: true, order });
  }),

  /* ── Admin order controllers ────────────────────────────── */

  /** GET /api/admin/orders  [admin] */
  getAllOrders: asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const skip   = (Number(page) - 1) * Number(limit);
    const total  = await Order.countDocuments(filter);
    const orders = await Order.find(filter)
      .populate("user", "name email phone companyName gstNumber")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    res.json({ success: true, total, page: Number(page), orders });
  }),

  /** GET /api/admin/orders/:id  [admin] */
  getOrderById: asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id)
      .populate("user", "name email phone companyName gstNumber");
    if (!order) throw new AppError("Order not found.", 404);
    res.json({ success: true, order });
  }),

  /**
   * PATCH /api/admin/orders/:id/status  [admin]
   * Simply updates the order status and optional admin notes.
   * Stock deduction has been removed entirely.
   */
  updateOrderStatus: asyncHandler(async (req, res) => {
    const { status, adminNotes } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError("Order not found.", 404);

    order.status = status;
    if (adminNotes !== undefined) order.adminNotes = adminNotes;
    await order.save();

    res.json({
      success: true,
      message: `Order status updated to '${status}'.`,
      order,
    });
  }),
};


/* ─────────────────────────────────────────────────────────
   9.5  COUPON CONTROLLERS
   ───────────────────────────────────────────────────────── */
const couponCtrl = {

  /** POST /api/admin/coupons  [admin] */
  create: asyncHandler(async (req, res) => {
    const coupon = await Coupon.create(req.body);
    res.status(201).json({ success: true, coupon });
  }),

  /** GET /api/admin/coupons  [admin] */
  getAll: asyncHandler(async (_req, res) => {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.json({ success: true, count: coupons.length, coupons });
  }),

  /** PATCH /api/admin/coupons/:id  [admin] */
  update: asyncHandler(async (req, res) => {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, {
      new: true, runValidators: true,
    });
    if (!coupon) throw new AppError("Coupon not found.", 404);
    res.json({ success: true, coupon });
  }),

  /** DELETE /api/admin/coupons/:id  [admin] */
  remove: asyncHandler(async (req, res) => {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) throw new AppError("Coupon not found.", 404);
    res.json({ success: true, message: "Coupon deleted." });
  }),

  /** POST /api/coupons/validate  — public (authenticated buyer) */
  validate: asyncHandler(async (req, res) => {
    const { code, orderAmount } = req.body;
    if (!code) throw new AppError("Coupon code is required.", 400);

    const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
    if (!coupon || coupon.expiryDate < new Date())
      throw new AppError("Invalid or expired coupon.", 400);
    if (coupon.maxUses && coupon.usedCount >= coupon.maxUses)
      throw new AppError("Coupon usage limit reached.", 400);

    const amount   = Number(orderAmount) || 0;
    const discount = coupon.discountType === "percent"
      ? +((amount * coupon.value) / 100).toFixed(2)
      : Math.min(coupon.value, amount);

    res.json({
      success: true,
      coupon: {
        code:         coupon.code,
        discountType: coupon.discountType,
        value:        coupon.value,
        discount,
        minOrderAmt:  coupon.minOrderAmt,
      },
    });
  }),
};


/* ─────────────────────────────────────────────────────────
   9.6  ADMIN — USER MANAGEMENT CONTROLLERS
   ───────────────────────────────────────────────────────── */
const adminUserCtrl = {

  /** GET /api/admin/users  [admin] */
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

  /** PATCH /api/admin/users/:id/toggle  [admin] */
  toggleActive: asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new AppError("User not found.", 404);
    user.isActive = !user.isActive;
    await user.save();
    res.json({
      success:  true,
      message:  `User ${user.isActive ? "activated" : "deactivated"}.`,
      isActive: user.isActive,
    });
  }),
};


// ============================================================
// §10  EXPRESS APP & ROUTES
// ============================================================
const app = express();

/* ── Core middleware ─────────────────────────────────────── */
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ── Static files (uploaded images) ─────────────────────────
   FIX: Images are stored as "/<UPLOAD_DIR>/filename.jpg" in the DB.
   The static middleware must be mounted at that same path prefix so
   GET /uploads/filename.jpg resolves to <cwd>/uploads/filename.jpg.
   Using express.static with an explicit route prefix (app.use("/uploads", ...))
   ensures the URL path and the filesystem path stay in sync regardless
   of what UPLOAD_DIR is set to in .env.
   ──────────────────────────────────────────────────────────── */
app.use(`/${UPLOAD_DIR}`, express.static(path.resolve(process.cwd(), UPLOAD_DIR)));

/* ── Health check ───────────────────────────────────────── */
app.get("/api/health", (_req, res) =>
  res.json({ success: true, message: "Induskriti API is running 🚀", timestamp: new Date() })
);

/* ── 10.1  Auth routes ──────────────────────────────────── */
const authRouter = express.Router();
authRouter.post("/register", validate(V.register),  authCtrl.register);
authRouter.post("/login",    validate(V.login),     authCtrl.login);
authRouter.get( "/me",       protect,               authCtrl.getMe);
authRouter.patch("/me",      protect,               authCtrl.updateMe);
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
productRouter.post(
  "/",
  protect, restrictTo("admin"),
  upload.array("images", 10),
  productCtrl.create
);
productRouter.patch(
  "/:id",
  protect, restrictTo("admin"),
  upload.array("images", 10),
  productCtrl.update
);
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

// Admin → orders
adminRouter.get("/orders",     orderCtrl.getAllOrders);
adminRouter.get("/orders/:id", orderCtrl.getOrderById);
adminRouter.patch(
  "/orders/:id/status",
  validate(V.updateOrderStatus),
  orderCtrl.updateOrderStatus
);

// Admin → coupons
adminRouter.post(  "/coupons",     validate(V.coupon), couponCtrl.create);
adminRouter.get(   "/coupons",                         couponCtrl.getAll);
adminRouter.patch( "/coupons/:id",                     couponCtrl.update);
adminRouter.delete("/coupons/:id",                     couponCtrl.remove);

// Admin → users
adminRouter.get(   "/users",            adminUserCtrl.getAll);
adminRouter.patch( "/users/:id/toggle", adminUserCtrl.toggleActive);

app.use("/api/admin", adminRouter);

/* ── 404 handler ─────────────────────────────────────────── */
app.use((_req, _res, next) => next(new AppError("Route not found.", 404)));

/* ── Global error handler (MUST be last) ─────────────────── */
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
    console.log("\nRoute map:");
    console.log("  POST   /api/auth/register");
    console.log("  POST   /api/auth/login");
    console.log("  GET    /api/auth/me");
    console.log("  PATCH  /api/auth/me");
    console.log("  GET    /api/categories");
    console.log("  GET    /api/products");
    console.log("  POST   /api/orders          ← WhatsApp checkout");
    console.log("  GET    /api/orders");
    console.log("  POST   /api/coupons/validate");
    console.log("  GET    /api/admin/orders");
    console.log("  PATCH  /api/admin/orders/:id/status  ← status update only");
    console.log("  POST   /api/admin/coupons");
    console.log("  GET    /api/admin/users");
  });
};

startServer();

// new server.js 16/5/26
