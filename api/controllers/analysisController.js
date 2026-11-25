const analysisService = require('../services/analysisService');
const storageService = require('../services/storageService');
const Analysis = require('../models/Analysis');
const Patient = require('../models/Patient');
const env = require('../config/env');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');

function getPublicApiOrigin(req) {
    if (req) {
        const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https')
            .toString()
            .split(',')[0]
            .trim();
        const host = req.headers['x-forwarded-host'] || req.get('host');
        if (host) return `${proto}://${host}`;
    }
    return (env.API_URL || '').trim().replace(/\/+$/, '');
}

function signImageUrl(analysisId, req, expiresInSeconds = 3600) {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = crypto
        .createHmac('sha256', `${env.JWT_SECRET}_img`)
        .update(`${analysisId}:${exp}`)
        .digest('hex');
    const origin = getPublicApiOrigin(req);
    return `${origin}/api/analyses/${analysisId}/image?exp=${exp}&sig=${sig}`;
}

function verifyImageSignature(analysisId, exp, sig) {
    if (!exp || !sig || typeof sig !== 'string') return false;
    const expNum = Number(exp);
    if (!Number.isInteger(expNum) || Math.floor(Date.now() / 1000) > expNum) {
        return false;
    }
    const expected = crypto
        .createHmac('sha256', `${env.JWT_SECRET}_img`)
        .update(`${analysisId}:${expNum}`)
        .digest('hex');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

// Devuelve una URL absoluta firmada hacia el proxy de esta API para evitar
// bloqueos CORS en Flutter Web (R2 sin CORS) y hosts internos (minio:9000).
async function formatAnalysisWithPresignedUrl(analysis, req) {
    if (!analysis) return null;
    const formatted = { ...analysis };
    if (
        formatted.image_uri &&
        !formatted.image_uri.startsWith('http') &&
        !formatted.image_uri.startsWith('retiscan://')
    ) {
        formatted.image_uri = signImageUrl(formatted.id, req);
    }
    return formatted;
}

const analysisController = {
    // POST /api/analyses
    // Respondemos de inmediato con 202 Accepted (status PENDING).
    // La IA procesa la imagen en segundo plano.
    async createAnalysis(req, res, next) {
        try {
            const { eye, doctorNotes } = req.body;
            let patientId = req.body.patientId;
            let doctorId = req.user.id;

            // Si quien sube es el paciente, resolvemos su registro y al médico dueño
            if (req.user.role === 'PACIENTE') {
                const patient = await Patient.findByUserId(req.user.id);
                if (!patient) {
                    return res.status(404).json({ error: 'Perfil de paciente no encontrado' });
                }
                patientId = patient.id;
                doctorId = patient.doctor_id;
            }

            let imageUri = req.body.imageUri;

            if (req.file) {
                // Subir el buffer directo a MinIO con un nombre único
                const filename = `${uuidv4()}${path.extname(req.file.originalname || '.jpg')}`;
                imageUri = await storageService.uploadImage(req.file.buffer, filename, req.file.mimetype);
            }

            const analysis = await analysisService.createAnalysis({
                patientId,
                doctorId,
                eye: eye || 'LEFT', // default temporal
                imageUri,
                doctorNotes,
            });

            const responseAnalysis = await formatAnalysisWithPresignedUrl(analysis, req);

            return res.status(202).json({
                message: 'Análisis en cola — el procesamiento de IA ha comenzado en segundo plano',
                analysis: responseAnalysis,
            });
        } catch (err) {
            next(err);
        }
    },

    // GET /api/analyses/patient/:patientId
    // Lista de análisis de un paciente, solo los del médico autenticado.
    async getAnalysisByPatient(req, res, next) {
        try {
            const analyses = await analysisService.getByPatientAndDoctor(
                req.params.patientId,
                req.user.id
            );
            const formattedAnalyses = await Promise.all(analyses.map(a => formatAnalysisWithPresignedUrl(a, req)));
            return res.status(200).json({ count: formattedAnalyses.length, analyses: formattedAnalyses });
        } catch (err) {
            next(err);
        }
    },

    // GET /api/analyses/my
    // Vista del paciente: solo sus propios análisis.
    async getMyAnalyses(req, res, next) {
        try {
            const analyses = await analysisService.getByPatientUserId(req.user.id);
            const formattedAnalyses = await Promise.all(analyses.map(a => formatAnalysisWithPresignedUrl(a, req)));
            return res.status(200).json({ count: formattedAnalyses.length, analyses: formattedAnalyses });
        } catch (err) {
            next(err);
        }
    },

    // GET /api/analyses/:id
    // Detalle de un análisis, con verificación de propiedad:
    // el paciente solo ve los suyos y el médico solo los de sus pacientes.
    async getAnalysisById(req, res, next) {
        try {
            const id = req.params.id;
            const analysis = await require('../models/Analysis').findById(id);
            if (!analysis) {
                return res.status(404).json({ error: 'Análisis no encontrado' });
            }

            if (req.user.role === 'PACIENTE') {
                const patient = await Patient.findByUserId(req.user.id);
                if (!patient || patient.id !== analysis.patient_id) {
                    return res.status(404).json({ error: 'Análisis no encontrado' });
                }
            } else if (req.user.role === 'MEDICO') {
                if (analysis.doctor_id !== req.user.id) {
                    return res.status(404).json({ error: 'Análisis no encontrado' });
                }
            }

            const formattedAnalysis = await formatAnalysisWithPresignedUrl(analysis, req);
            return res.status(200).json({ analysis: formattedAnalysis });
        } catch (err) {
            next(err);
        }
    },

    // GET /api/analyses/:id/logs
    // Logs de auditoría del procesamiento de IA.
    async getAnalysisLogs(req, res, next) {
        try {
            const logs = await analysisService.getLogsForAnalysis(req.params.id);
            return res.status(200).json({ count: logs.length, logs });
        } catch (err) {
            next(err);
        }
    },

    // DELETE /api/analyses/:id
    // Elimina un análisis, siempre que pertenezca al médico autenticado.
    async deleteAnalysis(req, res, next) {
        try {
            await analysisService.delete(req.params.id, req.user.id);
            return res.status(200).json({ message: 'Análisis eliminado' });
        } catch (err) {
            next(err);
        }
    },

    // GET /api/analyses/:id/image?exp=...&sig=...
    // Sirve la retinografía desde R2/MinIO con firma temporal HMAC y headers CORS.
    async getAnalysisImage(req, res, next) {
        try {
            const { id } = req.params;
            const { exp, sig } = req.query;

            if (!verifyImageSignature(id, exp, sig)) {
                return res.status(403).json({ error: 'Enlace de imagen inválido o expirado' });
            }

            const analysis = await Analysis.findById(id);
            if (!analysis || !analysis.image_uri || analysis.image_uri.startsWith('retiscan://')) {
                return res.status(404).json({ error: 'Imagen no encontrada' });
            }

            if (analysis.image_uri.startsWith('http')) {
                return res.redirect(analysis.image_uri);
            }

            const { body, contentType, contentLength } = await storageService.getImageObject(analysis.image_uri);

            let finalContentType = contentType;
            if (!finalContentType || finalContentType === 'application/octet-stream' || !finalContentType.startsWith('image/')) {
                finalContentType = analysis.image_uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
            }

            res.setHeader('Content-Type', finalContentType);
            if (contentLength) {
                res.setHeader('Content-Length', contentLength);
            }
            res.setHeader('Cache-Control', 'private, max-age=3600');
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

            if (typeof body.pipe === 'function') {
                body.on('error', (streamErr) => {
                    console.error(`[AnalysisImage] Error en stream de ${id}:`, streamErr.message);
                    if (!res.headersSent) {
                        res.status(502).json({ error: 'Error al leer la imagen desde almacenamiento' });
                    } else {
                        res.end();
                    }
                });
                return body.pipe(res);
            }

            const bytes = await body.transformToByteArray();
            return res.send(Buffer.from(bytes));
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                return res.status(404).json({ error: 'Imagen no encontrada en almacenamiento' });
            }
            next(err);
        }
    },

    // PUT /api/analyses/:id/notes
    // Actualiza las notas médicas de un análisis.
    async updateAnalysisNotes(req, res, next) {
        try {
            const { notes } = req.body;
            const updated = await analysisService.updateNotes(req.params.id, req.user.id, notes);
            const formatted = await formatAnalysisWithPresignedUrl(updated, req);
            return res.status(200).json({ message: 'Notas actualizadas', analysis: formatted });
        } catch (err) {
            next(err);
        }
    },
};

module.exports = analysisController;
