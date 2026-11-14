package im.plum.plumbox.client

import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString
import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-GCM sealing for [KeystoreTokenStore], kept free of android.* so it is
 * tested on the JVM with an ordinary key. The blob is
 * `base64( version(1) | ivLength(1) | iv | ciphertext+tag )`; the IV comes
 * from the cipher (the Android Keystore insists on choosing it), and [aad]
 * binds the blob to the store it was written by.
 */
internal object SealedBox {
    private const val VERSION: Byte = 1
    private const val TAG_BITS = 128
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    fun seal(key: SecretKey, plaintext: String, aad: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(aad)
        val iv = cipher.iv
        val sealed = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return (byteArrayOf(VERSION, iv.size.toByte()) + iv + sealed).toByteString().base64()
    }

    /** The plaintext, or [GeneralSecurityException] when the blob was not sealed by [key] for [aad]. */
    fun open(key: SecretKey, blob: String, aad: ByteArray): String {
        val bytes = blob.decodeBase64()?.toByteArray() ?: throw GeneralSecurityException("not base64")
        if (bytes.size < 2 || bytes[0] != VERSION) throw GeneralSecurityException("unknown format")
        val ivLen = bytes[1].toInt() and 0xff
        if (ivLen < 12 || bytes.size < 2 + ivLen + TAG_BITS / 8) throw GeneralSecurityException("truncated")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, bytes, 2, ivLen))
        cipher.updateAAD(aad)
        val plain = cipher.doFinal(bytes, 2 + ivLen, bytes.size - 2 - ivLen)
        return String(plain, Charsets.UTF_8)
    }
}
